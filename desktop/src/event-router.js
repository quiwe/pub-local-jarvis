"use strict";

function routeBackendEvent(event) {
  const payload = event && event.payload ? event.payload : {};
  switch (event && event.topic) {
    case "perception.completed":
      return [{ type: "scene", scene: payload.scene || "other" }];
    case "assistant.message":
      return payload.text ? [{ type: "bubble", text: payload.text, tone: "info" }] : [];
    case "course.interaction":
      return payload.text ? [{ type: "bubble", text: payload.text, tone: "course" }] : [];
    case "barrage.generated":
      return payload.text ? [{ type: "barrage", text: payload.text }] : [];
    case "course.started":
      return [
        { type: "scene", scene: "course" },
        { type: "bubble", text: `开始记录课程：${payload.title || "未命名课程"}`, tone: "course" },
      ];
    case "course.keyframe.requested":
      return [{ type: "capture", ...payload }];
    case "course.finished":
      return [
        { type: "scene", scene: "other" },
        {
          type: "bubble",
          text: "课程总结已经生成，已保存到桌面。",
          tone: "success",
          outputPath: payload.output_path || null,
          duration: 12000,
        },
      ];
    case "worker.fatal":
      return [{ type: "fault", text: payload.error || "本地推理服务连接中断" }];
    default:
      return [];
  }
}

module.exports = { routeBackendEvent };
