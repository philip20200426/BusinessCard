# Posture.Guard — 浏览器端实时坐姿监测 · 开发总结

> 一个纯静态、全本地推理的实时姿态监测应用。所有计算在浏览器内完成，摄像头画面不上传任何服务器。
> 本文档面向学习者，逐块拆解实现原理。

---

## 0. 项目结构

```
BusinessCard/
├── index.html                    # 个人主页（作品集 landing page）
├── pose.html                     # 姿态监测主应用（核心）
├── placeholder_1280_720.png      # 摄像头未启动时的占位图
├── models/
│   └── pose_landmarker.task      # MediaPipe 姿态识别模型（9.4 MB）
└── vendor/mediapipe/
    ├── vision_bundle.js          # MediaPipe Tasks Vision 运行时（ESM）
    └── wasm/
        ├── vision_wasm_internal.js
        ├── vision_wasm_internal.wasm           # SIMD 版本
        ├── vision_wasm_nosimd_internal.js
        └── vision_wasm_nosimd_internal.wasm    # 非 SIMD 版本（自动降级）
```

**零构建、零依赖、零后端**。直接把整个目录丢到任意静态服务器就能跑。

---

## 1. 技术栈

| 层 | 选型 | 为什么 |
|---|---|---|
| 姿态推理 | MediaPipe Pose Landmarker (WASM) | 33 个关键点、CPU 实时 30 FPS、MIT 协议、有官方 JS binding |
| 运行时 | 浏览器原生 WebAssembly | 不需要 native 插件，所有现代浏览器都支持 |
| UI | 纯 HTML + CSS + 原生 JS（ESM module） | 不需要 React/Vue，单文件 1500 行搞定 |
| 数据持久化 | localStorage | 配置、阈值、预设存在浏览器里，刷新不丢 |
| 语音播报 | 浏览器原生 SpeechSynthesis API | 零依赖，Chrome/Edge/Safari 都支持 |
| 截图 | Canvas.toDataURL → base64 | 存在内存数组里，或导出为 jpg 下载 |

---

## 2. pose.html 核心架构

### 2.1 整体数据流

```
┌─────────────┐    MediaPipe     ┌──────────────┐    分析器      ┌───────────────┐
│  webcam     │ ──────────────▶ │ PoseLandmarker│ ─────────────▶ │   Analyzer    │
│  (1280×720) │    33关键点       │              │                │  (computeRaw) │
└─────────────┘                  └──────────────┘                └───────┬───────┘
                                                                         │
                              ┌──────────────────────────────────────────┤
                              ▼                  ▼              ▼        ▼
                        ┌────────────┐    ┌────────────┐  ┌──────────┐ ┌───────────┐
                        │ renderPanel│    │ maybeSpeak │  │checkSitting│ │renderStage│
                        │  数值/状态  │    │  语音播报   │  │ 久坐提醒   │ │  骨架绘制  │
                        └────────────┘    └────────────┘  └──────────┘ └───────────┘
```

### 2.2 启动流程

```
用户点击「▶ 启动检测」
    │
    ▼
initRunning()
    ├─ 首次调用 initModel()
    │   ├─ fetchWithProgress('models/pose_landmarker.task')  ← 9.4 MB 模型文件
    │   ├─ FilesetResolver.forVisionTasks('vendor/mediapipe/wasm/vision_wasm_internal.js')
    │   └─ PoseLandmarker.createFromOptions(baseOptions, options)
    │       └─ runningMode: 'VIDEO'  ← 视频模式（vs IMAGE）
    │
    ├─ startCamera()
    │   ├─ navigator.mediaDevices.getUserMedia({ video: true })
    │   └─ video.srcObject = stream
    │
    └─ loop()  ← requestAnimationFrame 主循环
```

### 2.3 关键点 → 指标（computeRaw）

MediaPipe 返回 33 个归一化坐标（0~1），分析器从这些点计算 10 个原始指标：

| 指标 | 计算来源 | 物理含义 |
|---|---|---|
| `head_drop` | NOSE.y - (L_SH.y + R_SH.y)/2 | 下巴到肩线的垂直距离（低头为负） |
| `head_lateral` | NOSE.x - (L_SH.x + R_SH.x)/2 | 鼻子偏离肩线中心的水平距离 |
| `torso_lateral` | (HIP.x + NOSE.x)/2 - (L_SH.x + R_SH.x)/2 | 躯干中点相对肩线的侧偏 |
| `shoulder_tilt` | L_SH.y - R_SH.y | 两肩高度差 |
| `face_too_close` | 2×|NOSE.x - L_EYE_OUTER.x|（近似人脸宽度） | 人脸宽度（肩宽归一化后） |
| `shoulder_rise` | 当前肩高 - 标定肩高 | 站立/坐下切换时肩高变化 |
| `neck_angle` | NOSE-肩线 的角度 | 脖子倾斜度 |
| `lean_angle` | 肩线-髋线 的角度 | 整体躯干倾斜 |
| `sit_duration` | sitStart 起算的毫秒 | 已持续坐姿时间 |
| `stand_state` | shoulder_rise 是否超阈值 | 站立/坐下二元状态 |

### 2.4 指标判定 —— 绝对阈值 + 相对阈值

每种异常有两套阈值，**绝对阈值**判断当前值是否越界，**相对阈值（delta）**判断是否偏离标定基准：

```js
thresholds: {
  abs_head_drop: -0.2,          // 绝对：下巴比正常低 20% 就判定低头
  head_drop_delta: 0.1,          // 相对：比标定值低 10% 就判定低头
  // ... 其他 9 个
}
```

这样设计的好处：**每个人的基准姿态不同**，标定一次后相对阈值自动适配个体差异；绝对阈值作为兜底，防止标定偏得太离谱。

### 2.5 状态机 —— 滤波 + 滞回 + 冷却

直接拿原始指标判定会抖动（比如低头一瞬间就报异常），需要三层去抖：

```
原始值 → 滑动窗口均值（filter_window 帧）
       → 确认期（confirm_bad 秒连续越界才判为异常；confirm_good 秒连续正常才判恢复）
       → 播报冷却（cooldown 秒内不重复播报同类异常）
```

三个预设档位对应不同参数：

| 档位 | filter_window | confirm_bad | confirm_good | cooldown |
|---|---|---|---|---|
| high（敏感） | 3 帧 | 2s | 4s | 20s |
| medium | 6 帧 | 5s | 10s | 45s |
| low（默认） | 9 帧 | 8s | 16s | 90s |

### 2.6 关键点可见性门控

MediaPipe 对每个关键点都返回一个 `visibility`（0~1）。身体被遮挡、转身、低头时，某些点的 visibility 会骤降。代码里设置了：

```
REQUIRED_POINTS = [NOSE, L_SH, R_SH]   // 只有这三个是硬要求
gate ≥ 0.3                             // 可见度 ≥ 30% 才参与计算
```

其他点（如髋、肘、手腕）visibility 不够时沿用上一帧的值，计算结果标为 `incomplete` 但仍可用于辅助判定。

### 2.7 异常自动留档

触发条件：**任一新异常项出现**

```
正常状态 → 异常状态（issues 从空变非空）
    → 截图一张

已经在异常状态中 → 又冒出新异常项（比如本来只有低头，现在又歪肩了）
    → 再截一张

异常恢复（issues 清空）
    → 重置已截记录集合，下次异常从头再截
```

保护机制：
- 最小间隔 5 秒，防止阈值边界抖动连拍
- 内存数组最多保留 12 张，新顶旧
- 设置开关 `auto_capture_on_bad` 可关闭

### 2.8 站立/坐下检测

通过肩高相对标定值的变化判断：
- 坐下时肩膀自然下沉 → `shoulder_rise < -0.08`
- 站立时肩膀抬起 → `shoulder_rise > 0.08`
- 加了 enter/exit 滞回防止边界抖动

### 2.9 久坐提醒

`sitStart` 记录进入坐姿的时间点，持续未站立超过 `sit_remind_minutes`（默认 30 分钟）触发播报，每 +30 分钟递进提醒。

### 2.10 画面绘制（canvas 叠加层）

骨架绘制在一个绝对定位的 `<canvas>` 上，覆盖在 `<video>` 上：
- 33 个关键点用小圆点标出（不同颜色区分身体部位）
- 12 条连线组成骨架（COCO 拓扑）
- 画面可选镜像（`transform: scaleX(-1)`，自拍体验）

### 2.11 配置持久化

```
STORE_KEY = 'pose_guard_cfg_v2'          // 主配置
PRESETS_STORE_KEY = 'pose_guard_presets_v1'  // 用户自定义的预设参数
```

所有设置（灵敏度、阈值、预设参数、镜像、自动留档）改完自动 `saveCfg()` 写入 localStorage，页面加载时 `loadCfg()` 读出。**改 STORE_KEY 版本号可以强制覆盖旧配置**（之前改过一次：`pose_guard_cfg_v1` → `v2`，因为发现 `stand_shoulder_rise` 默认值写得不对）。

---

## 3. index.html — 作品集主页

### 3.1 设计风格

- **终端/黑客风**：深色主题（bg-0 ~ bg-2 三层）、mono 字体（JetBrains Mono 等）、scanline/vignette 叠加层、背景粒子网络 canvas
- **顶部状态条**：实时时钟 `SYSTEM ONLINE · HH:MM:SS · NODE #0421`
- **Hero 关键字**：Android · Algorithm · LLM · AI-Vision · ... 斜体淡显、hover 才清晰
- **Terminal 模拟**：whoami / cat intent.txt / ./connect.sh 三条命令行 + 闪烁光标
- **Skill 卡片**：6 张（之前合并过，现在 4 张），2×2 对称网格
- **Projects**：卡片网格，pose.html 是其中一个（标了 LIVE 徽章）
- **Contact**：分两行，第一行强制一行不换行

### 3.2 响应式断点

```css
@media (max-width: 720px) {
  nav.topbar ul { display: none; }
  .skills-grid { grid-template-columns: 1fr; }  /* 手机单列 */
}
```

### 3.3 字体栈

```css
--sans: "Inter", "等线", "PingFang SC", "Noto Sans SC", "Microsoft YaHei", ...
```

"等线"放在第二优先级（Windows 10/11 自带），比微软雅黑更瘦更活；macOS 走 PingFang SC；Linux 走 Noto Sans SC。

---

## 4. 常见坑 & 踩过的雷

| 坑 | 现象 | 修复 |
|---|---|---|
| `stand_shoulder_rise` 默认值 0.29 太大 | 站着也被判定为坐着 | 改成 0.08 + bump STORE_KEY |
| `REQUIRED_POINTS` 门控 ≥0.5 | 骨架可见但 state = NO_PERSON | 改成 ≥0.3，只需 nose + 双肩 |
| 只在「异常跳变沿」截图 | 恢复确认要等 16s，两次异常之间没完全恢复就不截 | 改成「任一新异常项出现即截图」 |
| `.stage` 高度塌缩 | 摄像头未启动时占位图看不见 | 加 `aspect-ratio: 16/9` |
| 浏览器缓存 | 更新后看到旧版 | 服务器设 `Cache-Control: no-store`，用户 `Ctrl+Shift+R` |
| 模型文件 fetch 无进度条 | 9.4MB 下载时用户以为卡死 | `fetchWithProgress()` 手动 ReadableStream 读取 |
| WASM SIMD 不兼容 | 某些老浏览器加载失败 | MediaPipe 自带 nosimd 版本自动降级 |

---

## 5. 为什么能在任何联网电脑上跑

**这个应用是"零后端"的**，运行时唯一需要联网的时刻：

| 资源 | 大小 | 来源 | 缓存 |
|---|---|---|---|
| HTML/CSS/JS | ~60 KB | Cloudflare Pages | 浏览器缓存 + Cloudflare 边缘缓存 |
| `pose_landmarker.task` | 9.4 MB | Cloudflare Pages | 浏览器本地缓存（第二次秒开） |
| `vision_bundle.js` + WASM | ~3 MB | Cloudflare Pages | 浏览器本地缓存 |

**全部内容都是静态资源**，Cloudflare Pages 把它们分发到全球 300+ 边缘节点，任何地方访问都是最近节点响应。

运行时不需要后端 API、不需要数据库、不需要鉴权——摄像头直接在用户本地浏览器里处理，数据不离开设备。

**浏览器权限**：首次启动监测时，浏览器会弹「允许使用摄像头」请求。用户点允许后才能开始。这是浏览器安全机制，不是我们的代码。

---

## 6. 部署到 Cloudflare Pages

### 方案 A：Dashboard 直接上传（最简单，不需要 git/wrangler）

1. 打开 https://pages.cloudflare.com → 登录
2. 点 **Create a project** → **Direct Upload**（不是 Git 连接）
3. Project name 随便填，Production branch 随便
4. 点 **Upload assets** → 把 `d:\code\BusinessCard` 整个文件夹拖进去
5. 等 10 秒 → 拿到 `https://<name>.pages.dev` 子域名

**每次更新**：回到同一个项目 → **Assets** tab → **Upload new assets** → 重新拖整个文件夹。

### 方案 B：Git 自动部署（推荐长期使用）

```powershell
# 1. 初始化 git（当前不是 git repo）
cd d:\code\BusinessCard
git init
git add .
git commit -m "init"

# 2. 推到 GitHub（或 GitLab）
git branch -M main
git remote add origin https://github.com/<你的用户名>/<仓库名>.git
git push -u origin main

# 3. Cloudflare Pages → Create a project → Connect to Git
#    选 GitHub → 授权 → 选仓库
#    Framework preset: None
#    Build command: （留空）
#    Build output directory: .
#    → 保存
```

之后每次 `git push` 都会自动部署，1~2 分钟生效。

### MIME 类型检查

Cloudflare Pages 会自动识别 `.html` / `.js` / `.css` / `.png`，但有两个文件需要确认：

| 文件 | 正确 MIME | 为什么 |
|---|---|---|
| `vision_wasm_internal.wasm` | `application/wasm` | 浏览器需要这个 MIME 才能加载 WASM |
| `pose_landmarker.task` | `application/octet-stream` | MediaPipe fetch 时按二进制读 |

Cloudflare Pages 默认就处理对了，不用额外配置。

### 自定义域名（可选）

在 Pages 项目 → **Custom domains** → **Set up a custom domain** → 填你的域名 → 按提示去 DNS 服务商加一条 CNAME 到 `<name>.pages.dev`。Cloudflare 自动签发 Let's Encrypt 证书。

### 本地调试 vs 生产

| 项 | 本地 | 生产 |
|---|---|---|
| URL | `http://127.0.0.1:8899/pose.html` | `https://<name>.pages.dev/pose.html` |
| Cache-Control | 手动设 `no-store` | Cloudflare 默认边缘缓存 2 小时 + 浏览器缓存 |
| 摄像头授权 | http://localhost 自动允许 | https 自动允许（http 公网会拒绝） |
| WASM 加载 | 直接文件路径 | 相对路径，全部同源 ✓ |

---

## 7. 学习路线建议

按这个顺序看源码（都在 pose.html 一个文件里）：

1. **DOM 结构**（第 260~450 行）—— 一眼看清页面布局
2. **CSS**（第 8~260 行）—— 理解视觉风格
3. **常量 & 配置**（第 450~590 行）—— PRESETS、DEFAULT_CFG、METRIC_DEFS
4. **Analyzer 类**（第 618~870 行）—— 核心算法，`computeRaw()` 是重头戏
5. **initModel() + startCamera() + loop()**（第 872~1040 行）—— 启动流水线
6. **drawStage()**（第 1077 行起）—— 骨架绘制
7. **maybeSpeakState() + captureShot()**（第 1320 行起）—— 异常处理
8. **设置绑定**（第 1413 行起）—— UI ↔ 配置双向同步

在浏览器控制台可以用调试句柄实验：

```js
// 手动触发一次截图（不需要启动摄像头）
window.PG.captureShot('manual');

// 换预设
window.PG.cfg.sensitivity = 'high';
// 改阈值
window.PG.cfg.thresholds.head_drop_delta = 0.15;
```
