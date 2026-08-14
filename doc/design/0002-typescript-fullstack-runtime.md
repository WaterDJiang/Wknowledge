# ADR-0002：TypeScript 全栈与执行面分离

- 状态：接受
- 决策：Next.js 承载 UI 与 HTTP 控制面，Node Worker 承载长任务，PostgreSQL/pg-boss 承载状态与队列。
- Python：仅通过稳定 JSON CLI 契约执行文档、OCR 和 ASR 工具，不访问业务数据库。
- 理由：共享 TypeScript 契约，降低私有化部署组件数，保留将 GPU/Python 工具独立扩容的边界。
