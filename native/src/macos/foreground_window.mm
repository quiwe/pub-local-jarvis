#ifdef __APPLE__
#include "jarvis/worker.hpp"

#import <AppKit/AppKit.h>
#import <Cocoa/Cocoa.h>

#include <algorithm>
#include <cstring>
#include <string>

namespace jarvis {

std::uintptr_t get_foreground_window_id() noexcept {
  @autoreleasepool {
    NSWorkspace* workspace = [NSWorkspace sharedWorkspace];
    NSRunningApplication* frontApp = workspace.frontmostApplication;
    if (frontApp == nil) return 0;
    return static_cast<std::uintptr_t>(frontApp.processIdentifier);
  }
}

bool is_game_launcher_window(std::uintptr_t window_value) noexcept {
  if (window_value == 0) return false;
  @autoreleasepool {
    pid_t pid = static_cast<pid_t>(window_value);
    NSRunningApplication* app = [NSRunningApplication runningApplicationWithProcessIdentifier:pid];
    if (app == nil) return false;
    NSString* bundleId = app.bundleIdentifier ?: @"";
    NSString* appName = app.localizedName ?: @"";
    NSString* bundleIdLower = [bundleId lowercaseString];
    NSString* appNameLower = [appName lowercaseString];

    // Steam
    if ([bundleIdLower containsString:@"steam"] ||
        [appNameLower containsString:@"steam"]) {
      return true;
    }

    // Epic Games Launcher
    if ([bundleIdLower containsString:@"epicgames"] ||
        [appNameLower containsString:@"epic"]) {
      return true;
    }

    // Other common game launchers
    if ([bundleIdLower containsString:@"gog"] ||
        [bundleIdLower containsString:@"battle.net"] ||
        [bundleIdLower containsString:@"ubisoft"]) {
      return true;
    }

    return false;
  }
}

} // namespace jarvis
#endif
