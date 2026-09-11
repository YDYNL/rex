# ReX icon one-shot generator: crop watermark -> transparent bg -> multi-size -> hybrid ICO
# (256=PNG entry, others=BMP/DIB entries for maximum Windows taskbar/titlebar compatibility)
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File make-icons.ps1
# NOTE: keep this file pure ASCII - PS5.1 misreads UTF-8 no-BOM files as GBK and breaks parsing.
Add-Type -AssemblyName System.Drawing

$root = $PSScriptRoot
$src = Join-Path $root 'logo-src.png'
$pngDir = Join-Path $root 'png'
$logoPath = Join-Path $root '..\src\renderer\src\assets\logo.png'
New-Item -ItemType Directory -Force -Path $pngDir | Out-Null

Add-Type -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Collections.Generic;

public static class IconBuilder {
  static bool IsWhitePx(byte[] px, int stride, int x, int y) {
    int o = y * stride + x * 4;
    return px[o + 3] > 0 && px[o] >= 240 && px[o + 1] >= 240 && px[o + 2] >= 240;
  }

  // Edge flood-fill transparency: only white pixels connected to the border become
  // transparent (white inside the subject body is kept). Edge halo pixels get
  // alpha derived from luminance to remove the white fringe.
  public static void MakeTransparent(Bitmap bmp) {
    int W = bmp.Width, H = bmp.Height;
    Rectangle rect = new Rectangle(0, 0, W, H);
    BitmapData bd = bmp.LockBits(rect, ImageLockMode.ReadWrite, PixelFormat.Format32bppArgb);
    int stride = bd.Stride;
    byte[] px = new byte[stride * H];
    Marshal.Copy(bd.Scan0, px, 0, px.Length);

    bool[] marked = new bool[W * H];
    Queue<int> q = new Queue<int>();
    for (int x = 0; x < W; x++) {
      int top = x, bot = (H - 1) * W + x;
      if (IsWhitePx(px, stride, x, 0) && !marked[top]) { marked[top] = true; q.Enqueue(top); }
      if (IsWhitePx(px, stride, x, H - 1) && !marked[bot]) { marked[bot] = true; q.Enqueue(bot); }
    }
    for (int y = 0; y < H; y++) {
      int l = y * W, r = y * W + W - 1;
      if (IsWhitePx(px, stride, 0, y) && !marked[l]) { marked[l] = true; q.Enqueue(l); }
      if (IsWhitePx(px, stride, W - 1, y) && !marked[r]) { marked[r] = true; q.Enqueue(r); }
    }
    int[] dx = { 1, -1, 0, 0 };
    int[] dy = { 0, 0, 1, -1 };
    while (q.Count > 0) {
      int i = q.Dequeue();
      int x = i % W, y = i / W;
      for (int d = 0; d < 4; d++) {
        int nx = x + dx[d], ny = y + dy[d];
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        int j = ny * W + nx;
        if (marked[j] || !IsWhitePx(px, stride, nx, ny)) continue;
        marked[j] = true;
        q.Enqueue(j);
      }
    }

    int cnt = 0, halo = 0;
    for (int i = 0; i < W * H; i++) {
      if (!marked[i]) continue;
      px[(i / W) * stride + (i % W) * 4 + 3] = 0;
      cnt++;
    }
    for (int y = 1; y < H - 1; y++) {
      for (int x = 1; x < W - 1; x++) {
        int i = y * W + x;
        if (marked[i]) continue;
        if (!(marked[i - 1] || marked[i + 1] || marked[i - W] || marked[i + W])) continue;
        int o = y * stride + x * 4;
        int lum = (px[o] + px[o + 1] + px[o + 2]) / 3;
        if (lum >= 200) {
          int a = 255 - lum + 30;
          if (a < 1) a = 1;
          if (a > 255) a = 255;
          px[o] = 0; px[o + 1] = 0; px[o + 2] = 0; px[o + 3] = (byte)a;
          halo++;
        }
      }
    }
    Marshal.Copy(px, 0, bd.Scan0, px.Length);
    bmp.UnlockBits(bd);
    Console.WriteLine("transparent=" + cnt + " halo=" + halo);
  }

  static Bitmap Resize(Bitmap src, int size) {
    Bitmap dst = new Bitmap(size, size);
    using (Graphics g = Graphics.FromImage(dst)) {
      g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
      g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.HighQuality;
      g.PixelOffsetMode = System.Drawing.Drawing2D.PixelOffsetMode.HighQuality;
      g.DrawImage(src, new Rectangle(0, 0, size, size));
    }
    return dst;
  }

  static byte[] PngBytes(Bitmap bmp) {
    using (MemoryStream ms = new MemoryStream()) {
      bmp.Save(ms, ImageFormat.Png);
      return ms.ToArray();
    }
  }

  static void Put32(byte[] b, int o, int v) {
    b[o] = (byte)(v & 255); b[o + 1] = (byte)((v >> 8) & 255);
    b[o + 2] = (byte)((v >> 16) & 255); b[o + 3] = (byte)((v >> 24) & 255);
  }
  static void Put16(byte[] b, int o, int v) {
    b[o] = (byte)(v & 255); b[o + 1] = (byte)((v >> 8) & 255);
  }

  // BMP/DIB entry for ICO: BITMAPINFOHEADER(40) + bottom-up BGRA + zero AND mask.
  // For 32bpp icons the alpha channel governs transparency.
  static byte[] DibBytes(Bitmap bmp) {
    int W = bmp.Width, H = bmp.Height;
    Rectangle rect = new Rectangle(0, 0, W, H);
    BitmapData bd = bmp.LockBits(rect, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
    int stride = bd.Stride;
    byte[] src = new byte[stride * H];
    Marshal.Copy(bd.Scan0, src, 0, src.Length);
    bmp.UnlockBits(bd);

    int xorLen = W * H * 4;
    int maskRow = ((W + 31) / 32) * 4;
    int maskLen = maskRow * H;
    byte[] dib = new byte[40 + xorLen + maskLen];
    Put32(dib, 0, 40);            // biSize
    Put32(dib, 4, W);             // biWidth
    Put32(dib, 8, H * 2);         // biHeight (XOR + AND)
    Put16(dib, 12, 1);            // biPlanes
    Put16(dib, 14, 32);           // biBitCount
    Put32(dib, 16, 0);            // BI_RGB
    Put32(dib, 20, xorLen + maskLen);
    for (int y = 0; y < H; y++) {
      int sRow = y * stride;
      int dRow = 40 + (H - 1 - y) * W * 4;
      for (int x = 0; x < W; x++) {
        dib[dRow + x * 4] = src[sRow + x * 4];         // B
        dib[dRow + x * 4 + 1] = src[sRow + x * 4 + 1]; // G
        dib[dRow + x * 4 + 2] = src[sRow + x * 4 + 2]; // R
        dib[dRow + x * 4 + 3] = src[sRow + x * 4 + 3]; // A
      }
    }
    return dib; // AND mask area stays all zero
  }

  public static string Run(string srcPath, string icoPath, string pngDir, string logoPath) {
    using (Image img = Image.FromFile(srcPath)) {
      int W = img.Width, H = img.Height;
      int S = (int)(0.78 * Math.Min(W, H));
      int x0 = (W - S) / 2, y0 = (int)(0.05 * H);
      Bitmap master = new Bitmap(S, S);
      using (Graphics g = Graphics.FromImage(master)) {
        g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
        g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.HighQuality;
        g.PixelOffsetMode = System.Drawing.Drawing2D.PixelOffsetMode.HighQuality;
        g.DrawImage(img, new Rectangle(0, 0, S, S), new Rectangle(x0, y0, S, S), GraphicsUnit.Pixel);
      }
      MakeTransparent(master);

      int[] sizes = { 256, 128, 64, 48, 32, 16 };
      List<byte[]> blobs = new List<byte[]>();
      for (int k = 0; k < sizes.Length; k++) {
        int s = sizes[k];
        using (Bitmap rb = Resize(master, s)) {
          byte[] png = PngBytes(rb);
          File.WriteAllBytes(Path.Combine(pngDir, s + ".png"), png);
          if (s == 256) {
            blobs.Add(png);                    // 256 uses PNG entry (official standard)
            File.WriteAllBytes(logoPath, png); // topbar logo shares the same source
          } else {
            blobs.Add(DibBytes(rb));           // small sizes use BMP for max compatibility
          }
        }
      }
      master.Dispose();

      int total = 0;
      for (int k = 0; k < blobs.Count; k++) total += blobs[k].Length;
      byte[] ico = new byte[6 + 16 * sizes.Length + total];
      Put16(ico, 0, 0); Put16(ico, 2, 1); Put16(ico, 4, sizes.Length);
      int offset = 6 + 16 * sizes.Length;
      for (int k = 0; k < sizes.Length; k++) {
        int e = 6 + 16 * k;
        int s = sizes[k];
        ico[e] = (byte)(s >= 256 ? 0 : s);
        ico[e + 1] = (byte)(s >= 256 ? 0 : s);
        ico[e + 4] = 1;  // planes
        ico[e + 6] = 32; // bpp
        Put32(ico, e + 8, blobs[k].Length);
        Put32(ico, e + 12, offset);
        Buffer.BlockCopy(blobs[k], 0, ico, offset, blobs[k].Length);
        offset += blobs[k].Length;
      }
      File.WriteAllBytes(icoPath, ico);
      return "icon.ico " + ico.Length + " bytes (" + sizes.Length + " entries)";
    }
  }
}
'@ -ReferencedAssemblies System.Drawing

[IconBuilder]::Run($src, (Join-Path $root 'icon.ico'), $pngDir, $logoPath)
Write-Output "png dir: $pngDir"
Write-Output "topbar logo: $logoPath"
