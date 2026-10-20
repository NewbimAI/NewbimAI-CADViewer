# data/

用户上传的**原始图纸**，运行时放在 `data/uploads/`。

- **不入库**：本目录除这个说明文件外，全部被 `.gitignore` 忽略（`/data/*` + `!/data/README.md`）。
  图纸不会进仓库、不会被提交、也不会被发布。
- **不是缓存**：`server/cache/` 是派生缓存，可以随时整目录删除；这里是原件，**删了就没了**。
  所以"清缓存"和"清数据"是两件事。
- **位置可改**：环境变量 `CADVIEWER_DATA` 可把整个目录指到别的盘（例如 `D:\CADViewer-data`）。
- **目录自动创建**：`data/uploads/` 由服务端启动时 `mkdirSync` 建立，仓库里不需要提交空目录。
- **保留期**：默认 30 天，`UPLOAD_RETENTION_DAYS` 可改，设 `0` 表示永不清理。
