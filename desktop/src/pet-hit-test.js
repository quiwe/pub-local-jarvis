"use strict";

function isPetPointerInteractive(localX, localY, width, height, bubbleVisible) {
  const overPet = localX >= width - 162 && localX <= width - 8
    && localY >= height - 195 && localY <= height - 4;
  const overBubble = bubbleVisible && localX >= 18 && localX <= width - 62
    && localY >= 8 && localY <= 130;
  return overPet || overBubble;
}

module.exports = { isPetPointerInteractive };
