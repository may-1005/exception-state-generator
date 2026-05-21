# 项目概述
这是一个"界面异常状态生成器"设计工具。用户上传 UI 设计稿截图，工具自动生成对应的 7 种异常状态 HTML 页面。

# 技术栈
- 前端：纯静态 HTML/CSS/JS，部署在 Netlify
- 后端：Netlify Functions（Node.js）
- AI 引擎：智谱 GLM-5V-Turbo（OpenAI 兼容 API，baseURL: https://open.bigmodel.cn/api/paas/v4）
- 打包：archiver 库

# 关键设计决策
- 异常状态规范定义在 `guidelines/exception-states.md`，生成前必须读取
- 所有生成的 HTML 保持原设计视觉风格，仅替换核心内容
- 前端支持截图上传和链接粘贴两种输入方式
- 输出为 zip 包下载

# 命名规范
- 异常状态文件名用英文：empty.html, network-error.html 等
- 函数和变量用驼峰命名
- 配置和常量用大写+下划线
