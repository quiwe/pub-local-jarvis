cmake_minimum_required(VERSION 3.24)

if(NOT DEFINED JARVIS_RUNTIME_SOURCE_CACHE)
  message(FATAL_ERROR "Pass -DJARVIS_RUNTIME_SOURCE_CACHE=<absolute cache directory>")
endif()
if(NOT IS_ABSOLUTE "${JARVIS_RUNTIME_SOURCE_CACHE}")
  message(FATAL_ERROR "JARVIS_RUNTIME_SOURCE_CACHE must be absolute")
endif()

set(revision b9d15b83ee353b2eaeee4d9318c98a35a1347486)
set(archive "${JARVIS_RUNTIME_SOURCE_CACHE}/llama.cpp-omni-${revision}.tar.gz")
set(source_dir "${JARVIS_RUNTIME_SOURCE_CACHE}/llama.cpp-omni-${revision}")
file(MAKE_DIRECTORY "${JARVIS_RUNTIME_SOURCE_CACHE}")
file(DOWNLOAD
  "https://github.com/tc-mb/llama.cpp-omni/archive/${revision}.tar.gz"
  "${archive}"
  EXPECTED_HASH SHA256=f8505a9179ff4b8e3ca648c4d462ad46edcc7698507ab3717bc3ee840f45710c
  TLS_VERIFY ON
  STATUS download_status)
list(GET download_status 0 download_code)
if(NOT download_code EQUAL 0)
  list(GET download_status 1 download_message)
  file(REMOVE "${archive}")
  message(FATAL_ERROR "Pinned runtime download failed: ${download_message}")
endif()

if(NOT EXISTS "${source_dir}/CMakeLists.txt")
  file(ARCHIVE_EXTRACT INPUT "${archive}"
       DESTINATION "${JARVIS_RUNTIME_SOURCE_CACHE}")
endif()
if(NOT EXISTS "${source_dir}/LICENSE")
  message(FATAL_ERROR "Pinned runtime archive has an unexpected layout")
endif()

message(STATUS "Verified pinned runtime source: ${source_dir}")
message(STATUS "Configure with -DJARVIS_RUNTIME_UPSTREAM_SOURCE_DIR=${source_dir}")
