# ST Incremental Save Plugin

SillyTavern 增量保存插件：**聊天保存从 186MB 降到 6KB**，仅在追加新消息时生效。修改旧消息时自动回退 gzip 压缩全量保存。

## 效果

| 场景 | 原始 | 本插件 |
|------|------|------|
| 正常发消息 | 186MB 全量上传 | **6KB 增量追加** |
| metadata 保存 | 186MB | **4KB header-only** |
| 编辑旧消息 | 186MB | 186MB → gzip → **~56MB** (兜底) |
| 数据库注入记忆后 | 186MB | 186MB → gzip → **~56MB** |

## 原理

```
拦截 fetch('/api/chats/save') →
  ├─ 只有新消息 → 走 /save-append (只传新消息，几KB)
  └─ 有编辑/插入 → gzip 压缩后走 /save (兜底)
```

使用消息内容长度 + swipe_id 做轻量 hash，检测旧消息是否被修改。服务端用行数校验防止并发冲突，冲突时自动回退全量。

## 安装

### 方式一：URL 一键安装（推荐）

在酒馆 Extension Manager 中点击「安装扩展」，输入：

```
https://github.com/Ye-HHH/st-incremental-save-plugin
```

### 方式二：手动安装

```bash
# 客户端扩展
git clone https://github.com/Ye-HHH/st-incremental-save-plugin.git \
  SillyTavern/public/scripts/extensions/third-party/st-incremental-save-plugin
```

### 必需：服务端插件

**方式一：Docker**
```bash
docker cp server/incremental-save-server.js sillytavern:/home/node/app/plugins/
docker restart sillytavern
```

**方式二：本地**
```bash
cp server/incremental-save-server.js /path/to/SillyTavern/plugins/
# 重启酒馆
```

> 服务端插件注册 `/api/plugins/incremental-save/save-append` 路由，是增量保存必需的后端。

## 配置

浏览器 Console 或插件设置面板：

```js
// 调低 gzip 阈值（默认 100KB，只对大文件压缩）
window.__IncSave.updateSettings({ gzipMinBytes: 10240 })

// 查看设置
window.__IncSave.getSettings()

// 重置追踪状态（出现问题时）
window.__IncSave.resetTracking()
```

## Console 日志

```
[IncSave] INCREMENTAL appending 1 message(s): 6.0 KB (saved 185.99 MB) · 45ms
[IncSave] GZIP 186.04 MB → 56.34 MB (30.3%, 7520ms)
```

## 兼容性

- SillyTavern ≥ 1.16.0
- 浏览器需支持 `CompressionStream` API（Chrome 80+, Edge 80+, Firefox 113+）

## 与 CompressedSave 的关系

本插件**包含了 CompressedSave 的 gzip 功能**，两个同时装会冲突。如果装了本插件，可以卸载 CompressedSave。

## License

MIT — 基于 [ransxd/sillytavern-incremental-save](https://github.com/ransxd/sillytavern-incremental-save) 适配改造
