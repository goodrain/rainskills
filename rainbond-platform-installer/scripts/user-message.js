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
      "请选择应用运行的位置：",
      "",
      "1) 在线环境",
      "   无需安装平台，授权后即可开始部署。",
      "",
      "2) 自己的环境",
      "   应用运行在你自己的电脑、服务器或 Kubernetes 集群中。",
    ].join("\n"),
  },
  "own-environment-connection": {
    messageId: "runtime.own-environment-connection",
    message: [
      "请选择接入方式：",
      "",
      "1) 连接已有环境",
      "2) 帮我准备一个新环境",
    ].join("\n"),
  },
  "add-environment-location": {
    messageId: "runtime.add-environment-location",
    message: [
      "请选择要添加的运行环境：",
      "",
      "1) 在线环境",
      "2) 自己的环境",
    ].join("\n"),
  },
  "private-console-origin": {
    messageId: "runtime.private-console-origin",
    message: [
      "请提供已有私有 Rainbond 的 Console 地址。",
      "",
      "示例：https://rainbond.example.com",
    ].join("\n"),
  },
});

function privateDeploymentLocationMessage(controlPlatform) {
  const local = controlPlatform === "darwin"
    ? "1、安装到本地（当前 Mac，使用 OrbStack，安装可能较久）"
    : "1、安装到本地";
  return [
    "请选择部署位置：",
    "",
    local,
    "2、安装到 Linux 服务器",
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
      privateDeploymentLocationMessage(controlPlatform),
    );
  }
  const entry = USER_MESSAGES[id];
  if (!entry) throw new Error("runtime message id 无效");
  return renderUserMessage(entry.messageId, entry.message);
}

module.exports = {
  renderUserMessage,
  renderCatalogUserMessage,
  writeUserMessage,
};
