/**
 * dxf-viewer 的 Worker 入口。
 * 文件获取 + 解析 + 渲染准备全部在这个 worker 里做，主线程只收成品的几何缓冲
 * —— 这是 dxf-viewer 能"开巨型图不掉帧"的关键，别把它挪回主线程。
 */
import { DxfViewer } from "dxf-viewer";

DxfViewer.SetupWorker();
