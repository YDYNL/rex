import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type { RendererProps } from './registry'
import { useAppStore } from '../stores/appStore'

/** 3D 模型渲染器：stl/obj/ply/gltf/glb 真实渲染（three.js + 轨道交互） */
export default function ThreeRenderer({ doc }: RendererProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState('')
  const [stats, setStats] = useState('')
  const setDocContent = useAppStore((s) => s.setDocContent)

  useEffect(() => {
    let alive = true
    let dispose: (() => void) | null = null
    setError('')
    setStats('')

    const ext = doc.name.split('.').pop()?.toLowerCase() ?? ''
    const isText = ext === 'obj' || ext === 'gltf'

    const load = isText
      ? window.rex.file.readText(doc.path)
      : window.rex.file.readBuffer(doc.path)

    void load.then(async (r) => {
      if (!alive) return
      if (!r.ok) {
        setError(r.error)
        return
      }
      const host = hostRef.current
      if (!host) return

      try {
        /* ── 场景基建 ── */
        const scene = new THREE.Scene()
        scene.background = null
        const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 10000)
        const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
        host.appendChild(renderer.domElement)

        const controls = new OrbitControls(camera, renderer.domElement)
        controls.enableDamping = true

        scene.add(new THREE.HemisphereLight(0xffffff, 0x6750a4, 1.2))
        const dir = new THREE.DirectionalLight(0xffffff, 2)
        dir.position.set(5, 10, 7)
        scene.add(dir)

        /* ── 按格式解析模型 ── */
        const payload = r as { ok: true; data?: ArrayBuffer; content?: string }
        let object: THREE.Object3D
        if (ext === 'stl') {
          const geo = new STLLoader().parse(payload.data as ArrayBuffer)
          geo.computeVertexNormals()
          object = new THREE.Mesh(
            geo,
            new THREE.MeshStandardMaterial({ color: 0x7c4dff, metalness: 0.15, roughness: 0.45 })
          )
        } else if (ext === 'obj') {
          object = new OBJLoader().parse(payload.content ?? '')
          object.traverse((o) => {
            if (o instanceof THREE.Mesh) {
              o.material = new THREE.MeshStandardMaterial({
                color: 0x7c4dff,
                metalness: 0.15,
                roughness: 0.45
              })
            }
          })
        } else if (ext === 'ply') {
          const geo = new PLYLoader().parse(payload.data as ArrayBuffer)
          geo.computeVertexNormals()
          object = new THREE.Mesh(
            geo,
            new THREE.MeshStandardMaterial({ color: 0x7c4dff, metalness: 0.15, roughness: 0.45 })
          )
        } else {
          // gltf / glb
          const gltf = await new Promise<{ scene: THREE.Group }>((resolve, reject) => {
            new GLTFLoader().parse(
              payload.data as ArrayBuffer,
              '',
              (g) => resolve(g as unknown as { scene: THREE.Group }),
              (e) => reject(e)
            )
          })
          object = gltf.scene
        }
        scene.add(object)

        /* ── 自适应取景：包围盒居中 + 相机距离 ── */
        const box = new THREE.Box3().setFromObject(object)
        const center = box.getCenter(new THREE.Vector3())
        const size = box.getSize(new THREE.Vector3())
        const maxDim = Math.max(size.x, size.y, size.z) || 1
        object.position.sub(center)
        camera.position.set(maxDim * 1.2, maxDim * 0.9, maxDim * 1.5)
        camera.near = maxDim / 100
        camera.far = maxDim * 100
        camera.updateProjectionMatrix()
        controls.target.set(0, 0, 0)
        controls.update()

        /* ── 尺寸自适应 + 渲染循环 ── */
        const resize = (): void => {
          const w = host.clientWidth || 600
          const h = host.clientHeight || 400
          renderer.setSize(w, h)
          camera.aspect = w / h
          camera.updateProjectionMatrix()
        }
        resize()
        const ro = new ResizeObserver(resize)
        ro.observe(host)

        let raf = 0
        const tick = (): void => {
          controls.update()
          renderer.render(scene, camera)
          raf = requestAnimationFrame(tick)
        }
        tick()

        const vertexCount = ((): number => {
          let n = 0
          object.traverse((o) => {
            if (o instanceof THREE.Mesh) n += o.geometry.attributes.position?.count ?? 0
          })
          return n
        })()
        const s = `顶点 ${vertexCount.toLocaleString()} · 尺寸 ${size.x.toFixed(1)}×${size.y.toFixed(1)}×${size.z.toFixed(1)}`
        if (alive) {
          setStats(s)
          setDocContent(
            doc.id,
            `[3D 模型] ${doc.name}（${ext.toUpperCase()}），${s}。可就模型规格与文件信息提问。`
          )
        }

        dispose = (): void => {
          cancelAnimationFrame(raf)
          ro.disconnect()
          controls.dispose()
          renderer.dispose()
          scene.traverse((o) => {
            if (o instanceof THREE.Mesh) {
              o.geometry.dispose()
              const m = o.material
              if (Array.isArray(m)) m.forEach((x) => x.dispose())
              else m.dispose()
            }
          })
          renderer.domElement.remove()
        }
      } catch (e) {
        if (alive) {
          setError(`3D 模型解析失败：${String(e)}`)
          setDocContent(doc.id, `[3D 模型] ${doc.name}（解析失败）`)
        }
      }
    })

    return () => {
      alive = false
      dispose?.()
    }
  }, [doc.path, doc.id, doc.name, setDocContent])

  if (error) return <div className="sheet-error">⚠️ {error}</div>

  return (
    <div className="three-view">
      <div className="three-host" ref={hostRef} />
      <div className="three-tip">
        🧊 {doc.name} · {stats || '解析中…'} · 拖拽旋转 / 滚轮缩放
      </div>
    </div>
  )
}
