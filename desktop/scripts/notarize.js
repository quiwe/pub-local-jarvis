/**
 * Notarization hook for electron-builder.
 *
 * This script is called after code signing. To enable notarization, set:
 *   APPLE_ID=<your-apple-id>
 *   APPLE_APP_SPECIFIC_PASSWORD=<app-specific-password>
 *   APPLE_TEAM_ID=<your-team-id>
 *
 * If these environment variables are not set, notarization is skipped.
 */

"use strict";

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;

  // Only notarize macOS builds
  if (electronPlatformName !== "darwin") {
    return;
  }

  const appleId = process.env.APPLE_ID;
  const appleIdPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD;
  const teamId = process.env.APPLE_TEAM_ID;

  if (!appleId || !appleIdPassword || !teamId) {
    console.log("Skipping notarization: APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, or APPLE_TEAM_ID not set");
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = `${appOutDir}/${appName}.app`;

  console.log(`Notarizing ${appPath}...`);

  try {
    const { notarize } = require("@electron/notarize");
    await notarize({
      appBundleId: "com.aijarvis.desktop",
      appPath,
      appleId,
      appleIdPassword,
      teamId,
    });
    console.log("Notarization complete");
  } catch (error) {
    console.warn("Notarization failed (app will still work but may show Gatekeeper warnings):", error.message);
  }
};
