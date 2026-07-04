# FrameSync — 视频同帧同步对比

两个带计时器的视频，输入对应时间点即可自动同步到同一帧，并排对比播放。

## 怎么用

```bash
pip install -r requirements.txt
python app.py
```

浏览器打开 `http://localhost:5000`

### 操作流程

1. **加载视频** — 输入两个 MP4 文件路径
2. **框选计时器** — 在首帧画面上拖拽框选计时器区域（右上角约 82~98%x, 8~22%y）
3. **校准** — 自动采样 5 帧，手动输入每帧画面上看到的计时器值（格式 `MM:SS.mmm`）
4. **构建索引** — 线性插值建立 `timer → frame` 映射
5. **同步对比** — 拖动进度条，两边画面帧级同步，支持 ±1/±5 帧微调偏移

## 技术栈

- **后端**: Python + Flask + OpenCV + SciPy
- **前端**: 原生 HTML/CSS/JS + Canvas
- **同步原理**: 用户输入 N 个 `(帧号, 计时器秒数)` 校准点 → `scipy.interpolate.interp1d` 线性插值 → 任意时间定位对应帧

## 项目结构

```
video-sync/
├── app.py              # Flask API + 前端路由
├── indexer.py          # 视频索引引擎（帧提取、校准插值）
├── templates/
│   └── index.html      # 对比播放器前端
├── static/             # 静态资源（预留）
├── requirements.txt
├── .gitignore
└── README.md
```

## API 一览

| 方法 | 路径 | 用途 |
|------|------|------|
| POST | `/api/load-video` | 加载视频文件 |
| POST | `/api/video/{id}/roi` | 设置计时器选区 |
| GET | `/api/video/{id}/samples` | 获取采样帧列表 |
| POST | `/api/video/{id}/calibrate` | 添加校准点 |
| POST | `/api/video/{id}/build-index` | 构建索引 |
| GET | `/api/sync?timer=X&a=ID&b=ID` | 获取同步帧号 |
| GET | `/api/video/{id}/frame/{n}` | 提取指定帧 JPEG |
