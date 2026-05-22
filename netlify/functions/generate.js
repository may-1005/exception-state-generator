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

/** 重试配置：最大重试次数 */
const MAX_RETRIES = 3;
/** 重试基础等待时间（毫秒） */
const RETRY_BASE_DELAY_MS = 5_000;

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
 * 从本地文件系统读取 guidelines/exception-states.md 的完整内容
 * Netlify Functions 在部署时将整个项目目录打包，因此可直接用相对路径读取
 */
function readGuidelinesFile() {
  // 规范文件的相对路径（相对于本 JS 文件所在位置）
  const filePath = path.join(
    __dirname,
    "..",
    "..",
    "guidelines",
    "exception-states.md"
  );

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

/** 内置兜底规范 —— 仅在文件读取失败时使用 */
function getFallbackGuidelines() {
  return `
# 界面异常状态设计规范（兜底版）

## 总则
保持与原始 UI 一致的配色、字体、圆角、阴影风格；内联 CSS+SVG 图标；响应式 375px~1440px。

## 7 种异常状态
1. 网络异常：断网/超时图标 + "网络不可用" + 重试按钮
2. 数据为空：空状态插画(120~160px) + "暂无数据" + 操作按钮（新建/去逛逛）
3. 加载中：骨架屏（与原布局一致的灰色块轮廓）或 Spinner 动画
4. 搜索无结果：搜索图标 + "未找到相关结果" + 搜索建议/热门关键词
5. 服务器错误：bug图标 + "服务器出了点问题" + 安抚文案 + 重试 + 联系客服
6. 无权限：锁图标 + "没有访问权限" + 说明 + 申请权限/切换账号引导
7. 内容缺失/404：404图形 + "页面走丢了" + 返回首页/查看推荐

## 输出要求
每个 HTML 完全独立可运行，含中文注释和 CSS 变量。
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

  // --- 发送请求（带指数退避重试，最多 3 次）---
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

      // 请求成功发出，清除超时
      clearTimeout(timeoutId);

      // --- 遇到 429（频率限制），等待后重试 ---
      if (response.status === 429) {
        const retryAfterHeader = response.headers.get("Retry-After");
        const waitMs = retryAfterHeader
          ? parseInt(retryAfterHeader, 10) * 1000
          : RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1); // 指数退避：5s, 10s, 20s

        console.warn(`[GLM API] 429 限流，等待 ${waitMs / 1000}s 后重试 (${attempt}/${MAX_RETRIES})`);

        if (attempt < MAX_RETRIES) {
          await sleep(waitMs);
          continue; // 进入下一次重试
        } else {
          throw new Error(
            `API 调用频率超限，已重试 ${MAX_RETRIES} 次仍被限流。请稍后再试。`
          );
        }
      }

      // --- 遇到 5xx 服务端错误，也进行重试 ---
      if (response.status >= 500 && attempt < MAX_RETRIES) {
        const waitMs = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
        console.warn(
          `[GLM API] 服务端错误 ${response.status}，等待 ${waitMs / 1000}s 后重试 (${attempt}/${MAX_RETRIES})`
        );
        await sleep(waitMs);
        continue;
      }

      // 成功或非重试类错误，跳出循环
      break;

    } catch (fetchError) {
      clearTimeout(timeoutId);

      // 超时不重试（120秒已足够长）
      if (fetchError.name === "AbortError") {
        throw new Error("AI 模型响应超时（超过 120 秒），请稍后重试或尝试上传更小的截图");
      }

      // 网络层错误（DNS、连接拒绝等），可重试
      lastError = fetchError;
      if (attempt < MAX_RETRIES) {
        const waitMs = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
        console.warn(
          `[GLM API] 网络异常：${fetchError.message}，等待 ${waitMs / 1000}s 后重试 (${attempt}/${MAX_RETRIES})`
        );
        await sleep(waitMs);
        continue;
      }

      // 重试次数耗尽，抛出最后一次错误
      throw new Error(`网络请求失败（已重试 ${MAX_RETRIES} 次）：${fetchError.message}`);
    }
  }

  // --- 处理 HTTP 错误状态码 ---
  if (!response.ok) {
    let errorDetail = "";
    try {
      errorDetail = await response.text();
    } catch {
      errorDetail = "无法读取错误详情";
    }
    console.error("[Zhipu API] HTTP 错误:", response.status, errorDetail);

    // 根据常见状态码返回友好提示
    const statusMessages = {
      401: "API 密钥无效或已过期，请联系管理员检查 ZHIPU_API_KEY 配置",
      403: "API 调用被拒绝，请检查账户余额或 API 权限",
      429: "API 调用频率超限，请稍后再试",
      500: "智谱 AI 服务暂时不可用，请稍后重试",
      503: "智谱 AI 服务正在维护中，请稍后再试",
    };
    const friendlyMessage =
      statusMessages[response.status] ||
      `智谱 AI 接口返回错误（HTTP ${response.status}）：${errorDetail}`;

    throw new Error(friendlyMessage);
  }

  // --- 解析响应 ---
  let result;
  try {
    result = await response.json();
  } catch (parseError) {
    throw new Error("AI 服务返回了无效的响应格式，无法解析");
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
