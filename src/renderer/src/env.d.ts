/// <reference types="vite/client" />

/** vite 专属资源导入声明（pdf.js worker 等） */
declare module '*?url' {
  const src: string
  export default src
}
