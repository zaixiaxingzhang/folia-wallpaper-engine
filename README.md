# 壁纸引擎背景 / Wallpaper Engine Background

把本机 Wallpaper Engine 的壁纸接到 Folia 的播放页背景上。在「背景类型」里多出一个
**壁纸引擎**，选中后壁纸铺满播放页；场景壁纸是**实时渲染**的，不是截图。

## 它做什么

- **读库**：解析 Steam 的 `libraryfolders.vdf` 与各盘 `SteamLibrary`，扫描创意工坊
  `431960`（Wallpaper Engine）与 `projects/myprojects`，读每个 `project.json`；
  另从 Wallpaper Engine 的 `config.json` 取当前桌面壁纸，用于「跟随桌面」。
- **三类壁纸**：
  - `video`：直接用 `<video>` 播放，支持与播放器同步暂停、速度调节。
  - `web`：用 `<iframe>` 运行，带严格沙箱。
  - `scene`：交给内置的 WebWallGL 引擎解析 `scene.pkg` 并逐帧渲染，着色器、粒子、
    视差、SceneScript 都真实运行；鼠标移动会作为视差输入。
- **音频联动**：把 Folia 的 64 段实时频谱喂给引擎（音频响应类壁纸跟随音乐），
  并把当前歌曲 / 歌手 / 专辑 / 播放状态 / 进度 / 封面同步为「正在播放」
  （音频识别 / 媒体播放器类壁纸显示真实的曲目信息）。
- **歌词可读性避让**：每 2.5 秒采样歌词所在条带的真实亮度，按当前主题歌词色反解出
  所需叠色透明度，把对比度顶到设定档位（0 为关闭）。可叠加模糊、压暗、暗角、饱和度。
- **取图方式**：伪随机（按「种子 + 歌曲」确定性计算，同一首歌永远是同一张）/
  指定（整套壁纸网格点选，带搜索）/ 跟随桌面。

## 实现要点

- `main.cjs`：扫描壁纸库；起一个只监听 `127.0.0.1` 的只读 HTTP 服务，提供
  `/i/<id>/r/<相对路径>`（含 Range，供 `<video>` 与引擎取包）。路径被限制在登记过的
  壁纸目录内。
- `scene.cjs`：`scene.pkg` 的解析（表头 + 相对偏移 + 内嵌 PNG/JPEG 抽帧），用于引擎
  不可用时的静态兜底：按 `scene.json` 的绘制顺序把各层贴图叠回一张完整画面。
- `client.mjs`：注册背景类型、渲染层、叠色计算、设置面板。
- `vendor/webwallgl.global.min.js`：第三方实时渲染引擎，见 `THIRD_PARTY_NOTICES.txt`。

引擎不可用或解析失败时按 **实时渲染 → 合成静态图 → 单张原画 → 官方动画预览** 逐级降级，
不会留黑屏。

## 权限

只声明 `filesystem.data`：记住用户选了哪一张壁纸 / 哪几种取图偏好。
读取壁纸库发生在 Node 端并由本地回环服务提供，不需要用户逐个选文件；不访问外网。

## 兼容

Folia 0.7.21+（Folium 1.7+），桌面版；需在设置中开启模组系统。
需要本机安装 Wallpaper Engine 才有壁纸可选（否则列表为空，不影响其他功能）。

## 第三方

`webwallgl` v3.0.0，MIT，作者 oneincase（<https://github.com/oneincase/webwallgl>）。
许可证原文见 `vendor/LICENSE-webwallgl.txt`。

## 许可

MIT，见 `LICENSE`。
