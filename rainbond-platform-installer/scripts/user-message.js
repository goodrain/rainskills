"use strict";

const MESSAGE_ID_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const MESSAGE_MARKER_PATTERN = /\[RAINSKILLS_USER_MESSAGE_(?:BEGIN|END):/;
const USER_MESSAGES = Object.freeze({
  "new-application-environment": {
    messageId: "runtime.new-application-environment",
    message: [
      "可以，我会帮你完成应用识别、构建、部署和访问验证。",
      "",
      "不过目前还没有可用的应用运行环境。",
      "",
      "你刚安装的 Rainskills 是负责“部署”的 AI 助手，它会分析项目并执行部署流程；Rainbond 负责为应用提供稳定运行环境。",
      "",
      "请选择应用要运行的环境：",
      "",
      "1) 云端环境（免费体验）",
      "2) 私有环境（去对接）",
    ].join("\n"),
  },
  "private-console-origin": {
    messageId: "runtime.private-console-origin",
    message: [
      "请提供已有私有环境地址。",
      "",
      "示例：https://rainbond.example.com",
    ].join("\n"),
  },
});

function privateDeploymentLocationMessage() {
  return [
    "请选择部署位置：",
    "",
    "1、部署到本机",
    "2、部署到独立服务器",
    "3、部署到已有 Rainbond",
  ].join("\n");
}

function renderUserMessage(messageId, message) {
  if (typeof messageId !== "string" || !MESSAGE_ID_PATTERN.test(messageId)) {
    throw new Error("user message id 无效");
  }
  if (typeof message !== "string" || !message.trim()) {
    throw new Error("user message 内容无效");
  }
  if (MESSAGE_MARKER_PATTERN.test(message)) {
    throw new Error("user message 包含无效 marker");
  }

  const body = message.replace(/\r\n?/g, "\n").trimEnd();
  return `[RAINSKILLS_USER_MESSAGE_BEGIN:${messageId}]\n${body}\n[RAINSKILLS_USER_MESSAGE_END:${messageId}]\n`;
}

function writeUserMessage(write, messageId, message) {
  write(renderUserMessage(messageId, message));
}

function renderCatalogUserMessage(id, { controlPlatform = process.platform } = {}) {
  if (id === "private-deployment-location") {
    return renderUserMessage(
      "runtime.private-deployment-location",
      privateDeploymentLocationMessage(),
    );
  }
  const entry = USER_MESSAGES[id];
  if (!entry) throw new Error("runtime message id 无效");
  return renderUserMessage(entry.messageId, entry.message);
}

module.exports = {
  privateDeploymentLocationMessage,
  renderUserMessage,
  renderCatalogUserMessage,
  writeUserMessage,
};
