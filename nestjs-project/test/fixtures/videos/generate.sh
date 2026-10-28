#!/bin/sh
# Regenerates the tiny video fixtures used by the media and worker tests.
# Run inside the nestjs-api container: sh test/fixtures/videos/generate.sh
set -eu

cd "$(dirname "$0")"

SIZE=160x120
RATE=10
DURATION=1
VIDEO="testsrc=size=${SIZE}:rate=${RATE}:duration=${DURATION}"
AUDIO="sine=frequency=440:duration=${DURATION}"
GLOBAL="-v error -nostdin -y"
# Strip metadata so regenerated files only differ when the content does
OUTPUT="-map_metadata -1 -fflags +bitexact"

# H.264 + AAC, moov after mdat (ffmpeg's default MP4 layout)
ffmpeg $GLOBAL -f lavfi -i "$VIDEO" -f lavfi -i "$AUDIO" \
  -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac -b:a 32k \
  -shortest $OUTPUT h264-aac-moov-end.mp4

# H.264 + AAC, moov before mdat
ffmpeg $GLOBAL -f lavfi -i "$VIDEO" -f lavfi -i "$AUDIO" \
  -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac -b:a 32k \
  -shortest -movflags +faststart $OUTPUT h264-aac-faststart.mp4

# VP9 + Opus in WebM
ffmpeg $GLOBAL -f lavfi -i "$VIDEO" -f lavfi -i "$AUDIO" \
  -c:v libvpx-vp9 -deadline realtime -b:v 50k -c:a libopus -b:a 24k \
  -shortest $OUTPUT vp9-opus.webm

# HEVC, video only: codec outside the allowlist and no audio stream
ffmpeg $GLOBAL -f lavfi -i "$VIDEO" \
  -c:v libx265 -preset ultrafast -pix_fmt yuv420p -tag:v hvc1 \
  -x265-params log-level=error:pools=none $OUTPUT hevc.mp4

# Random bytes with a video extension
head -c 4096 /dev/urandom > not-a-video.mp4
