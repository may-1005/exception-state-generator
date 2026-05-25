/**
 * ============================================================
 * Netlify Function: 异常状态页面生成器
 * 路径: /.netlify/functions/generate
 * 方法: POST
 *
 * 功能概述:
 *   1. 接收前端上传的 UI 截图（base64）或 Pixso 链接
 *   2. 读取 guidelines/exception-states.md 作为状态规范
 *   3. 单次调用智谱 GLM-5V-Turbo（视觉+文本），分析截图并直接生成异常状态 HTML
 *   4. 将生成的所有 HTML 文件（含 index.html 切换预览页）打包成 ZIP 返回
 *
 * 环境变量（需在 Netlify Dashboard 中配置）:
 *   - ZHIPU_API_KEY: 智谱 AI API Key（从 https://open.bigmodel.cn/ 获取）
 *
 * 依赖:
 *   - archiver: 用于生成 ZIP 文件
 * ============================================================
 */

const fs = require("fs");
const path = require("path");
const archiver = require("archiver");

// ========================================
// 常量配置
// ========================================

/** 智谱 API 基础地址（OpenAI 兼容格式） */
const ZHIPU_BASE_URL = "https://open.bigmodel.cn/api/paas/v4";

/** 默认模型名称 */
const DEFAULT_MODEL = "GLM-5V-Turbo";

/** API 请求超时时间（毫秒） */
const API_TIMEOUT_MS = 120_000;

/** 重试配置 */
const MAX_RETRIES = 2;
/** 429 限流后等待时间（毫秒）—— 不急于重试，给 API 冷却时间 */
const RATE_LIMIT_DELAY_MS = 60_000;
/** 5xx 服务端错误后的等待基础时间（毫秒） */
const SERVER_ERROR_BASE_DELAY_MS = 15_000;

/**
 * CORS 响应头 — 允许前端跨域调用此 Function
 */
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

// ========================================
// 主处理函数入口
// ========================================
exports.handler = async (event, context) => {
  // --- OPTIONS 预检请求 ---
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: CORS_HEADERS, body: "" };
  }

  // --- 仅接受 POST ---
  if (event.httpMethod !== "POST") {
    return jsonError(405, "仅支持 POST 请求");
  }

  try {
    // 1. 解析并校验请求参数
    const { image, pixsoLink } = parseRequestBody(event.body);

    // 2. Pixso 链接暂未开放
    if (!image && pixsoLink) {
      return jsonResponse(200, {
        success: false,
        message:
          "Pixso 链接解析功能暂未开放，请使用截图上传方式。\n后续版本将支持直接解析 Pixso/Figma 设计稿链接。",
        hint: "您可以截取设计稿中的界面，通过拖拽或点击上传区域来使用本工具。",
      });
    }

    if (!image) {
      return jsonError(400, "请上传 UI 设计截图（image 字段不能为空）");
    }

    // 3. 读取异常状态规范文件
    const guidelinesText = readGuidelinesFile();

    // 4. 调用 GLM-5V-Turbo：一次性完成视觉分析 + HTML 生成
    console.log("[generate] 开始调用 GLM-5V-Turbo 生成异常状态...");
    const files = await callGLMAPI(image, guidelinesText);

    console.log(`[generate] 成功生成 ${files.length} 个文件，开始打包 ZIP...`);

    // 5. 打包 ZIP 并返回
    const zipBuffer = await createZip(files);
    const zipBase64 = zipBuffer.toString("base64");

    return jsonResponse(200, {
      success: true,
      message: `成功生成 ${files.length} 个异常状态页面`,
      fileName: "exception-states.zip",
      fileData: zipBase64,
      files: files.map((f) => ({ name: f.name })),
    });
  } catch (error) {
    console.error("[generate] 发生错误:", error);
    return jsonError(
      500,
      error.message || "服务器内部错误，请稍后重试"
    );
  }
};

// ========================================
// 工具函数：构建标准 JSON 响应
// ========================================

/** 返回成功的 JSON 响应 */
function jsonResponse(statusCode, body) {
  return { statusCode, headers: CORS_HEADERS, body: JSON.stringify(body) };
}

/** 返回错误 JSON 响应 */
function jsonError(statusCode, message) {
  return jsonResponse(statusCode, { success: false, error: message });
}

/**
 * 异步等待指定毫秒数（用于重试退避）
 * @param {number} ms - 等待时间（毫秒）
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ========================================
// 步骤 1：解析请求体
// ========================================

function parseRequestBody(rawBody) {
  let body;
  try {
    body = JSON.parse(rawBody || "{}");
  } catch {
    throw new Error("请求体格式错误：必须是有效的 JSON 字符串");
  }

  const { image, pixsoLink } = body;

  if (!image && !pixsoLink) {
    throw new Error("缺少必要参数：请提供 image（截图）或 pixsoLink（链接）");
  }

  return { image, pixsoLink };
}

// ========================================
// 步骤 2：读取规范文件
// ========================================

/**
 * 读取异常状态规范内容
 * 优先从本地文件读取，失败则使用内嵌的完整兜底规范
 *
 * 注意：Netlify Functions 运行时仅包含 netlify/functions/ 目录，
 * 因此根目录下的 guidelines/ 文件不可访问，会自动降级到内嵌版本
 */
function readGuidelinesFile() {
  // 尝试多个可能的路径（本地开发 vs Netlify 部署）
  const candidates = [
    // 路径 1：Netlify 部署后，文件可能在 /var/task/guidelines/
    path.join("/var/task", "guidelines", "exception-states.md"),
    // 路径 2：相对于函数目录向上两级到项目根目录
    path.join(__dirname, "..", "..", "guidelines", "exception-states.md"),
    // 路径 3：与函数同级目录
    path.join(__dirname, "guidelines", "exception-states.md"),
  ];

  for (const filePath of candidates) {
    try {
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, "utf-8");
        console.log(`[guidelines] 成功读取规范文件: ${filePath}, 长度: ${content.length}`);
        return content;
      }
    } catch {
      // 继续尝试下一个路径
    }
  }

  try {
    const content = fs.readFileSync(filePath, "utf-8");
    console.log("[guidelines] 成功读取规范文件，长度:", content.length);
    return content;
  } catch (error) {
    console.warn("[guidelines] 无法读取规范文件，使用内置兜底规范:", error.message);
    // 如果文件读取失败，返回一个精简版兜底规范，确保功能不中断
    return getFallbackGuidelines();
  }
}

/** 内置完整规范 —— 作为主要规范来源（Netlify 部署后外部文件不可访问） */
function getFallbackGuidelines() {
  return `
# 界面异常状态设计规范（状态池）

## 规范总则
1. 视觉一致性：所有异常状态页面应与原始 UI 设计保持一致的配色、字体、圆角、阴影等视觉风格
2. 可访问性：确保对比度符合 WCAG AA 标准，图标配有文字说明
3. 响应式：异常状态组件需适配移动端和桌面端（375px ~ 1440px）
4. 交互反馈：提供明确的操作引导按钮

## 异常状态类型（7 种）

### 1. 网络异常（Network Error）
- 描述：无网络或连接不稳定
- 触发场景：网络断开、请求超时、服务器无响应、DNS 解析失败
- 必须包含：断网/警告图标、"网络不可用"提示文案、错误详情描述、重试按钮、次要操作（检查网络设置/返回首页）、若可行展示缓存内容
- 技术建议：自动重试机制（带指数退避）；区分于服务端错误的视觉表现（不同图标/颜色）

### 2. 空数据状态（Empty State）
- 场景：页面有结构但无数据（首次使用）、无历史记录、搜索/筛选无结果
- 必须包含：居中空状态插画/图标(120px~160px)、标题文案（如"暂无数据"）、辅助说明、主要操作入口（如"去逛逛""新建""添加"）、次要操作链接（可选）
- 布局要求：内容垂直居中占据容器主要空间；文字与按钮间距16px~24px；搜索无结果应额外提供搜索建议或热门关键词

### 3. 加载中状态（Loading State）
- 场景：页面初始化、数据请求、文件上传等
- 实现方式按场景选择：
  - 骨架屏 Skeleton：首屏加载使用，与原页面布局一致，灰色块模拟内容轮廓
  - Spinner：圆形旋转动画，适用于局部/轻量级加载
  - 进度条：适用于可预估进度的长耗时操作
- 注意事项：避免全屏遮罩阻塞用户操作；超过3秒应显示预计等待时间或取消选项；骨架屏布局结构应与真实内容区域一一对应

### 4. 错误 / 失败状态（Error / Failure）
- 场景：操作失败、服务器 5xx 错误、表单提交失败、接口返回业务错误码
- 必须包含：服务器/bug 图标（区别于网络异常）、友好错误标题（如"操作失败""系统繁忙"）、明确错误描述、解决方案指引、"重试"或"返回"按钮、反馈入口（联系客服/报告问题）
- 注意：不暴露技术错误信息给终端用户；与网络异常在视觉上做区分；表单类错误应在对应字段旁内联展示而非整页替换

### 5. 权限 / 访问限制（Permission / Access Denied）
- 场景：无模块权限、需要登录、角色不足、资源访问被拒绝
- 必须包含：锁/禁止图标、标题（如"没有访问权限""需要登录"）、说明文案（解释原因+如何获取权限）、操作引导（申请权限/联系管理员/切换账号/升级账户）、返回导航
- 设计要点：语气友好但不模糊；有获取权限路径务必清晰展示；登录态丢失优先引导重新登录

### 6. 内容缺失状态（Content Missing）
- 场景：内容被删除、页面不存在(404)、功能建设中、数据被过滤后无结果
- 必须包含：缺失状态视觉元素（404图形/建设中插画/已删除标记）、友好标题、辅助说明、导航路径（返回首页/查看其他内容/搜索其他内容/查看热门推荐）
- 特殊处理：
  - 页面级 404：可增加趣味性插画降低挫败感
  - 搜索结果为空：归入空数据状态，提供搜索建议
  - 功能建设中：可加入预计上线时间或订阅通知入口
  - 内容被删除：提供相关推荐内容的替代路径

### 7. 极端数据状态（Extreme Data）
- 场景：内容过载、超长文本溢出、数字溢出、大图加载缓慢、列表数据量过大
- 技术实现方式按场景选用：
  - 超长文本：截断 + "展开全部"/"收起" 按钮
  - 数字溢出：科学计数法或简化显示（如"1.2万"）
  - 大图/大量图片：懒加载 + 渐进式图片加载 + 占位符
  - 列表过载：虚拟滚动 / 分页 / "加载更多"
  - 存储/配额超限：进度条或环形图展示用量占比（>80%提前预警），提供升级/清理引导

## 设计参考库
- Ant Design 异常状态指南：https://ant.design/docs/spec/research-exception
- Material 3 Empty States：https://m3.material.io/foundations/content-design/empty-states

## HTML 输出规范
- 每个HTML文件完全独立，内联CSS和SVG图标，不依赖外部资源
- 文件命名格式：[原组件名]-[异常状态英文].html
- 包含中文注释标注各区域用途
- 响应式适配（375px移动端 ~ 1440px桌面端）
- 使用CSS变量方便主题定制
`;
}

// ========================================
// 步骤 3 & 4：调用 GLM-5V-Turbo API（核心逻辑）
// ========================================

/**
 * 单次调用智谱 GLM-5V-Turbo，同时完成：
 *   - 视觉理解：分析 UI 截图的布局、配色、组件特征
 *   - 文本生成：根据规范直接输出完整的异常状态 HTML 代码
 *
 * @param {string} imageBase64 - 用户上传截图的 base64（可能含 data:image 前缀）
 * @param {string} guidelines - 异常状态规范的完整文本内容
 * @returns {Promise<Array<{name: string, content: string}>>} 生成的文件列表
 */
async function callGLMAPI(imageBase64, guidelines) {
  // --- 校验 API Key ---
  const apiKey = process.env.ZHIPU_API_KEY;
  if (!apiKey) {
    throw new Error(
      "服务未配置 API 密钥。请联系管理员在环境变量中设置 ZHIPU_API_KEY。" +
      "\n获取地址：https://open.bigmodel.cn/"
    );
  }

  const model = process.env.ZHIPU_MODEL || DEFAULT_MODEL;

  // --- 清理 base64 数据 ---
  let cleanBase64 = imageBase64;
  if (imageBase64.includes(",")) {
    cleanBase64 = imageBase64.split(",")[1];
  }

  // --- 构建 System Prompt：注入角色定义 + 异常状态规范全文 ---
  const systemPrompt = `你是一个资深的前端开发工程师和 UI 设计师。你的任务是根据用户提供的 UI 设计截图，分析其视觉风格，然后按照给定的异常状态规范，生成一套完整的异常状态 HTML 页面。

以下是必须遵循的异常状态设计规范：

${guidelines}

## 代码生成要求
1. 每个异常状态是一个完全独立的 HTML 文件，从 <!DOCTYPE html> 到 </html>
2. 所有样式使用内联 <style> 标签，不依赖任何外部 CSS 框架
3. 所有图标使用内联 SVG，不引用外部图标库
4. 使用 CSS 变量（:root {}）定义主题色彩，方便后续定制
5. 包含中文注释标注各区域用途
6. 支持响应式布局，适配 375px（移动端）到 1440px（桌面端）
7. 保持与原始截图一致的视觉风格（配色方案、字体规范、圆角大小、阴影样式等）

## 必须生成的文件列表（共 8 个）
除了以下 7 个异常状态页面外，还必须额外生成一个 index.html 作为切换预览页：
1. network-error.html     — 网络异常
2. empty-state.html       — 数据为空
3. loading.html           — 加载中（骨架屏）
4. no-search-results.html — 搜索无结果
5. server-error.html      — 服务器错误
6. no-permission.html     — 无权限
7. not-found.html         — 内容缺失 / 404
8. index.html             — 切换预览页（包含 iframe 或 tab 切换机制，可以预览以上 7 个页面）

## 输出格式
你必须且只能输出一个 JSON 对象，格式如下，不要输出任何其他内容：
{"files": [{"name": "文件名.html", "content": "完整的HTML代码字符串"}, ...]}

注意：content 字段中的 HTML 代码必须完整、可直接运行，不要省略任何部分。`;

  // --- 构建 User Prompt：图片 + 明确的任务指令 ---
  const userPrompt = `请分析这个 UI 界面的视觉设计风格，然后根据异常状态规范，生成一套完整的 HTML 异常状态页面。

需要生成的页面包括：网络异常、数据为空、加载中（骨架屏）、搜索无结果、服务器错误、无权限、内容缺失/404。

额外生成一个 index.html 用于切换预览所有异常状态页面。

每个状态独立 HTML 文件，保持原设计的视觉风格。输出格式为 JSON：{"files": [{"name": "xxx.html", "content": "完整HTML代码"}, ...]}`;

  // --- 构建请求体（OpenAI 兼容格式）---
  const requestBody = {
    model: model,
    messages: [
      {
        role: "system",
        content: systemPrompt,
      },
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: {
              url: `data:image/png;base64,${cleanBase64}`,
            },
          },
          {
            type: "text",
            text: userPrompt,
          },
        ],
      },
    ],
    temperature: 0.7,
    max_tokens: 32000,
  };

  // --- 发送请求（慢速重试策略：不急于重试）---
  let response;
  let lastError;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

    try {
      console.log(`[GLM API] 第 ${attempt}/${MAX_RETRIES} 次请求...`);

      response = await fetch(`${ZHIPU_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      // --- 429 频率限制：固定等 60 秒再重试，给 API 充分冷却时间 ---
      if (response.status === 429) {
        const retryAfterHeader = response.headers.get("Retry-After");
        const waitMs = retryAfterHeader
          ? parseInt(retryAfterHeader, 10) * 1000
          : RATE_LIMIT_DELAY_MS;

        console.warn(
          `[GLM API] 429 限流，等待 ${Math.round(waitMs / 1000)}s 后重试 (${attempt}/${MAX_RETRIES})`
        );

        if (attempt < MAX_RETRIES) {
          await sleep(waitMs);
          continue;
        } else {
          throw new Error(
            `API 调用频率超限，已等待冷却并重试 ${MAX_RETRIES} 次。` +
            `\n建议：换一个 API Key 或等待几分钟后重试。`
          );
        }
      }

      // --- 5xx 服务端错误：慢速重试 ---
      if (response.status >= 500 && attempt < MAX_RETRIES) {
        const waitMs = SERVER_ERROR_BASE_DELAY_MS * attempt; // 15s, 30s
        console.warn(
          `[GLM API] 服务端错误 ${response.status}，等待 ${Math.round(waitMs / 1000)}s 后重试 (${attempt}/${MAX_RETRIES})`
        );
        await sleep(waitMs);
        continue;
      }

      // 成功或非重试类错误，跳出循环
      break;

    } catch (fetchError) {
      clearTimeout(timeoutId);

      // 超时不重试
      if (fetchError.name === "AbortError") {
        throw new Error("AI 模型响应超时（超过 120 秒），请稍后重试或尝试上传更小的截图");
      }

      // 网络层错误：慢速重试
      lastError = fetchError;
      if (attempt < MAX_RETRIES) {
        const waitMs = SERVER_ERROR_BASE_DELAY_MS * attempt;
        console.warn(
          `[GLM API] 网络异常：${fetchError.message}，等待 ${Math.round(waitMs / 1000)}s 后重试 (${attempt}/${MAX_RETRIES})`
        );
        await sleep(waitMs);
        continue;
      }

      throw new Error(`网络请求失败（已重试 ${MAX_RETRIES} 次）：${fetchError.message}`);
    }
  }

  console.log('[API] Status:', response.status);
  console.log('[API] Content-Type:', response.headers.get('content-type'));

  const rawText = await response.text();
  console.log('[API] Body (first 800 chars):', rawText.substring(0, 800));

  const contentType = response.headers.get('content-type') || '';

  // --- 处理 HTTP 错误状态码或非 JSON 响应 ---
  if (!response.ok || !contentType.includes('application/json')) {
    const errorInfo = `Status: ${response.status}, Content-Type: ${contentType}, Body: ${rawText.substring(0, 500)}`;
    console.error('[API] 响应异常:', errorInfo);

    if (!response.ok) {
      const statusMessages = {
        401: "API 密钥无效或已过期，请联系管理员检查 ZHIPU_API_KEY 配置",
        403: "API 调用被拒绝，请检查账户余额或 API 权限",
        429: "API 调用频率超限，请稍后再试",
        500: "智谱 AI 服务暂时不可用，请稍后重试",
        503: "智谱 AI 服务正在维护中，请稍后再试",
      };
      const friendlyMessage =
        statusMessages[response.status] ||
        `智谱 AI 接口返回错误（${errorInfo})`;
      throw new Error(friendlyMessage);
    }

    throw new Error(`AI 服务返回了非 JSON 响应（${errorInfo}）`);
  }

  // --- 解析 JSON 响应 ---
  let result;
  try {
    result = JSON.parse(rawText);
  } catch (parseError) {
    throw new Error(`AI 服务返回了无效的 JSON 格式（Body 前 500 字符: ${rawText.substring(0, 500)}）`);
  }

  // 提取 AI 生成的文本内容
  const rawText = result?.choices?.[0]?.message?.content || "";

  if (!rawText) {
    console.error("[Zhipu API] 空响应:", JSON.stringify(result));
    throw new Error("AI 模型返回了空的结果，可能是输入图片过大或服务暂时异常");
  }

  // --- 解析 AI 返回的 JSON（提取 files 数组）---
  let parsedFiles;
  try {
    parsedFiles = parseAIGeneratedJSON(rawText);
  } catch (parseError) {
    console.error("[generate] JSON 解析失败，原始文本前 500 字符:", rawText.slice(0, 500));
    throw new Error(
      `AI 返回的内容格式不符合要求，无法提取文件列表。原因：${parseError.message}`
    );
  }

  // --- 校验文件列表 ---
  if (!Array.isArray(parsedFiles) || parsedFiles.length === 0) {
    throw new Error("AI 未生成任何有效文件，请重试或更换截图后重试");
  }

  // 过滤出有效的文件条目（必须有 name 和 content）
  const validFiles = parsedFiles.filter(
    (f) => f.name && typeof f.content === "string" && f.content.trim().length > 0
  );

  if (validFiles.length === 0) {
    throw new Error("AI 生成的文件内容均为空，请重试");
  }

  if (validFiles.length < 8) {
    console.warn(
      `[generate] 预期生成 8 个文件，实际获得 ${validFiles.length} 个`
    );
  }

  return validFiles;
}

/**
 * 解析 AI 返回的文本，提取 JSON 格式的文件列表
 * AI 可能会在 JSON 外面包裹 ```json ... ``` 代码块标记，
 * 也可能返回 {"files": [...]} 或直接返回 [...] 数组格式
 *
 * @param {string} rawText - AI 返回的原始文本
 * @returns {Array<{name: string, content: string}>} 文件列表
 */
function parseAIGeneratedJSON(rawText) {
  let text = rawText.trim();

  // 移除可能的 markdown 代码块包裹
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\s*\n?/, "");
    text = text.replace(/\n?```\s*$/, "");
  }

  let parsed = JSON.parse(text);

  // 兼容两种格式：{"files": [...]} 或直接是 [...]
  if (parsed.files && Array.isArray(parsed.files)) {
    return parsed.files;
  }
  if (Array.isArray(parsed)) {
    return parsed;
  }

  throw new Error("期望的格式为 {\"files\": [{\"name\":\"...\",\"content\":\"...\"}]} 或数组格式");
}

// ========================================
// 步骤 5：打包 ZIP
// ========================================

/**
 * 将生成的 HTML 文件列表打包成 ZIP 格式的 Buffer
 *
 * @param {Array<{name: string, content: string}>} files - 文件列表
 * @returns {Promise<Buffer>} ZIP 文件的二进制数据
 */
function createZip(files) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    // 自定义输出流收集器
    const outputStream = {
      write(chunk) {
        chunks.push(chunk);
      },
      end() {
        resolve(Buffer.concat(chunks));
      },
    };

    const archive = archiver("zip", { zlib: { level: 9 } });

    archive.on("error", reject);
    archive.pipe(outputStream);

    // 逐个添加 HTML 文件
    files.forEach((file) => {
      // 清理文件名，防止路径遍历攻击
      const safeName = file.name.replace(/[^a-zA-Z0-9_\-./]/g, "_");
      archive.append(file.content, { name: safeName });
    });

    // 附带 README 说明文件
    const readme = `# 异常状态页面生成结果

生成时间: ${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}
文件数量: ${files.length} 个

## 文件列表
${files.map((f) => `- ${f.name}`).join("\n")}

## 使用说明
1. 直接用浏览器打开 index.html 可切换预览所有异常状态
2. 每个 HTML 文件也可单独打开查看
3. 所有样式均为内联 CSS，无需启动服务器
4. 如需修改配色，可通过 CSS 变量快速调整

---
由 Exception State Generator (GLM-5V-Turbo) 自动生成
`;
    archive.append(readme, { name: "README.txt" });

    archive.finalize();
  });
}
