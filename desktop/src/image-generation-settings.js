"use strict";

const fs = require("node:fs");

function normalizeSettings(value, previous = {}) {
  const baseUrl = String(value?.baseUrl || previous.baseUrl || "").trim().slice(0, 2048).replace(/\/+$/, "");
  const modelName = String(value?.modelName || previous.modelName || "").trim().slice(0, 256);
  const providedKey = String(value?.apiKey || "").trim();
  const apiKey = providedKey || String(previous.apiKey || "");
  return { baseUrl, modelName, apiKey };
}

function publicSettings(settings) {
  return {
    baseUrl: settings.baseUrl || "",
    modelName: settings.modelName || "",
    hasApiKey: Boolean(settings.apiKey),
  };
}

function loadSettings(filePath, decrypt) {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const apiKey = value.encryptedApiKey ? decrypt(String(value.encryptedApiKey)) : "";
    return normalizeSettings({ baseUrl: value.baseUrl, modelName: value.modelName, apiKey });
  } catch (_) {
    return { baseUrl: "", modelName: "", apiKey: "" };
  }
}

function saveSettings(filePath, value, encrypt) {
  const normalized = normalizeSettings(value);
  if (!normalized.baseUrl || !normalized.modelName || !normalized.apiKey) {
    throw new Error("请完整填写 Base URL、API Key 和模型名称");
  }
  const payload = {
    baseUrl: normalized.baseUrl,
    modelName: normalized.modelName,
    encryptedApiKey: encrypt(normalized.apiKey),
  };
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
  return normalized;
}

module.exports = { loadSettings, normalizeSettings, publicSettings, saveSettings };
