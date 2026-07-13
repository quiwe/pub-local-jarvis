"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { routeBackendEvent } = require("../src/event-router");

test("game perception hides the pet through a scene effect", () => {
  assert.deepEqual(
    routeBackendEvent({ topic: "perception.completed", payload: { scene: "game" } }),
    [{ type: "scene", scene: "game" }]
  );
});

test("generated barrage is forwarded without business logic", () => {
  assert.deepEqual(
    routeBackendEvent({ topic: "barrage.generated", payload: { text: "漂亮的反杀！" } }),
    [{ type: "barrage", text: "漂亮的反杀！" }]
  );
});

test("course interaction uses the course bubble", () => {
  assert.deepEqual(
    routeBackendEvent({ topic: "course.interaction", payload: { text: "先想想这个条件为何必要。" } }),
    [{ type: "bubble", text: "先想想这个条件为何必要。", tone: "course" }]
  );
});

test("course completion returns to pet mode and exposes the output", () => {
  const effects = routeBackendEvent({
    topic: "course.finished",
    payload: { output_path: "C:/Users/test/Desktop/Jarvis-Courses/lesson/README.md" },
  });
  assert.equal(effects[0].scene, "other");
  assert.equal(effects[1].tone, "success");
  assert.match(effects[1].text, /课程总结/);
  assert.match(effects[1].outputPath, /README\.md$/);
});

test("keyframe requests remain backend directed", () => {
  assert.deepEqual(
    routeBackendEvent({
      topic: "course.keyframe.requested",
      payload: { id: "lesson", timestamp_ms: 1200, note: "F=ma" },
    }),
    [{ type: "capture", id: "lesson", timestamp_ms: 1200, note: "F=ma" }]
  );
});
