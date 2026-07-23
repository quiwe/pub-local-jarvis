"use strict";

function isPetPointerInteractive(localX, localY, width, height, bubbleVisible, chatVisible = false) {
  const overPet = localX >= width - 176 && localX <= width - 8
    && localY >= height - 232 && localY <= height - 4;
  const overBubble = bubbleVisible && localX >= 6 && localX <= width - 126
    && localY >= 8 && localY <= 170;
  const overChat = chatVisible && localX >= 12 && localX <= width - 170
    && localY >= 8 && localY <= height - 16;
  return overPet || overBubble || overChat;
}

module.exports = { isPetPointerInteractive };
