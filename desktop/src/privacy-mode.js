"use strict";

const PRIVACY_MESSAGES = Object.freeze([
  "在干嘛？让我看看！",
  "你是在背着我偷偷看什么见不得 AI 的东西吗？",
  "画面黑掉了，我可还在这儿呢。",
  "这么神秘？双击我就可以把画面还回来。",
  "我现在什么都看不见，有点在意你那边发生了什么。",
]);

function randomPrivacyDelay(random = Math.random, minimum = 25_000, maximum = 55_000) {
  return Math.floor(minimum + random() * (maximum - minimum + 1));
}

function randomPrivacyMessage(random = Math.random) {
  return PRIVACY_MESSAGES[Math.floor(random() * PRIVACY_MESSAGES.length)];
}

module.exports = { PRIVACY_MESSAGES, randomPrivacyDelay, randomPrivacyMessage };
