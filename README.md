# FrameSync — 视频同帧同步对比

两个带计时器的视频，手动标注计时器数值对齐两个视频，纯前端实现，无需任何后端。

## 🚀 在线使用（无需安装）

直接打开 GitHub Pages 即可使用：

👉 **https://testiphi.github.io/video-sync/**

所有处理在浏览器本地完成，不上传任何文件。

## 📦 本地运行

```bash
# 克隆仓库
git clone https://github.com/Testiphi/video-sync.git
cd video-sync

# 任何 HTTP 服务器打开 index.html
python -m http.server 8765
# 浏览器打开 http://localhost:8765
```

## 使用流程

### ① 加载视频
- 输入视频文件路径（如 `E:\Software\CapCut\Videos\0611.mp4`）
- 点击「浏览」选择文件（支持 Chromium 获取完整路径）
- 或直接拖放视频文件到面板
- 浏览器本地处理，不上传任何文件

### ② 框选计时器区域
- 在画面上拖拽框选计时器出现的区域
- 使用滑块 / 🎲 随机跳转浏览不同画面
- 或点击「自动」设置默认区域（右上角 82%×8%）
- 选区以百分比坐标存储，与视频分辨率无关

### ③ 校准计时器
- 播放视频 → 在合适位置暂停
- 在下方输入当前画面计时器数值（秒），点击「添加」
- 添加 2 个以上校准点（覆盖不同时间位置），自动计算线性回归
- 下方显示「计时器区域放大效果」辅助读取
- 显示回归公式 `视频时间 = a × 计时器 + b` 和拟合优度 R²

### ④ 同步对比
- 两个视频索引都构建完成后自动进入同步模式
- 拖动滑块控制目标计时器值 → 两个视频同时跳到对应位置
- B 视频偏移微调 ±0.1s / ±1s

## 技术栈

- **纯静态 HTML / CSS / JS** — 一个 `index.html` 搞定所有
- **视频处理**: `<video>` 元素 + Canvas 截图
- **回归算法**: 最小二乘法线性回归（纯 JS 实现）

## 与 Flask 版的差异

本版本是 commit `1b74227`（线性回归版）的纯静态重构版本：

| 功能 | 原版 (Flask) | 本版 (静态) |
|------|-------------|------------|
| 视频加载 | Flask API → OpenCV | 浏览器 `<video>` 直接加载 |
| 帧画面 | 服务端 OpenCV 逐帧提取 JPEG | 浏览器 Canvas 从 `<video>` 截取 |
| OCR | 服务端 EasyOCR | **已移除** |
| 帧号 | OpenCV 精确帧号 | 视频时间（精度不变） |
| 校准数据 | 服务端内存 | JS 对象 |
| 回归 | 服务端 numpy polyfit | JS 最小二乘法 |

## 项目结构

```
video-sync/
├── index.html         # 完整单页应用
├── .gitignore
├── .nojekyll          # GitHub Pages 部署标识
├── LICENSE
└── README.md
```
