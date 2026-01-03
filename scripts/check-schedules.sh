#!/bin/bash

# Script to check schedules and trigger downloads via API
# This script is run by cron

SCHEDULES_FILE="/downloads/.schedules.json"
API_URL="http://localhost:80/api/download"

# Check if schedules file exists
if [ ! -f "$SCHEDULES_FILE" ]; then
    exit 0
fi

# Read schedules JSON and check each one
# Using jq if available, otherwise fallback to python
if command -v jq &> /dev/null; then
    # Use jq to parse JSON
    # Get current time in milliseconds (seconds * 1000)
    NOW=$(( $(date +%s) * 1000 ))
    
    # Get enabled schedules where nextRun <= now
    schedules=$(jq -r --argjson now "$NOW" '
        .[] | 
        select(.enabled == true and .nextRun <= $now) | 
        @json
    ' "$SCHEDULES_FILE")
    
    if [ -z "$schedules" ]; then
        exit 0
    fi
    
    # Process each schedule
    echo "$schedules" | while IFS= read -r schedule_json; do
        schedule_id=$(echo "$schedule_json" | jq -r '.id')
        url=$(echo "$schedule_json" | jq -r '.url')
        path=$(echo "$schedule_json" | jq -r '.path // empty')
        audio_only=$(echo "$schedule_json" | jq -r '.audioOnly // false')
        resolution=$(echo "$schedule_json" | jq -r '.resolution // "1080"')
        is_playlist=$(echo "$schedule_json" | jq -r '.isPlaylist // false')
        is_channel=$(echo "$schedule_json" | jq -r '.isChannel // false')
        max_videos=$(echo "$schedule_json" | jq -r '.maxVideos // empty')
        interval_minutes=$(echo "$schedule_json" | jq -r '.intervalMinutes')
        
        echo "[$(date -Iseconds)] Triggering download for schedule: $schedule_id"
        
        # Build JSON payload
        payload=$(jq -n \
            --arg url "$url" \
            --arg path "$path" \
            --argjson audio_only "$audio_only" \
            --arg resolution "$resolution" \
            --argjson is_playlist "$is_playlist" \
            --argjson is_channel "$is_channel" \
            --argjson max_videos "${max_videos:-null}" \
            '{
                url: $url,
                path: (if $path == "" then null else $path end),
                audioOnly: $audio_only,
                resolution: $resolution,
                isPlaylist: $is_playlist,
                isChannel: $is_channel,
                maxVideos: $max_videos
            } | with_entries(select(.value != null))')
        
        # Trigger download via API
        response=$(curl -s -X POST "$API_URL" \
            -H "Content-Type: application/json" \
            -d "$payload")
        
        if echo "$response" | jq -e '.success' > /dev/null 2>&1; then
            echo "[$(date -Iseconds)] Download triggered successfully for schedule: $schedule_id"
            
            # Update schedule: set lastRun and nextRun
            python3 << EOF
import json
import time

with open("$SCHEDULES_FILE", "r") as f:
    schedules = json.load(f)

now = int(time.time() * 1000)
interval_ms = $interval_minutes * 60 * 1000

for schedule in schedules:
    if schedule["id"] == "$schedule_id":
        schedule["lastRun"] = now
        schedule["nextRun"] = now + interval_ms
        break

with open("$SCHEDULES_FILE", "w") as f:
    json.dump(schedules, f, indent=2)
EOF
        else
            echo "[$(date -Iseconds)] Failed to trigger download for schedule: $schedule_id"
            echo "[$(date -Iseconds)] Response: $response"
        fi
    done
    
else
    # Fallback to python if jq is not available
    python3 << 'PYTHON_SCRIPT'
import json
import time
import urllib.request
import urllib.parse

SCHEDULES_FILE = "/downloads/.schedules.json"
API_URL = "http://localhost:80/api/download"

try:
    with open(SCHEDULES_FILE, "r") as f:
        schedules = json.load(f)
except FileNotFoundError:
    exit(0)
except json.JSONDecodeError:
    print(f"[{time.strftime('%Y-%m-%dT%H:%M:%S')}] Error: Invalid JSON in schedules file")
    exit(1)
except Exception as e:
    print(f"[{time.strftime('%Y-%m-%dT%H:%M:%S')}] Error reading schedules file: {e}")
    exit(1)

# Ensure schedules is a list
if not isinstance(schedules, list):
    print(f"[{time.strftime('%Y-%m-%dT%H:%M:%S')}] Error: Schedules file does not contain a list")
    exit(1)

now = int(time.time() * 1000)
updated = False

for schedule in schedules:
    if not schedule.get("enabled", False):
        continue
    
    if schedule.get("nextRun", 0) <= now:
        schedule_id = schedule["id"]
        print(f"[{time.strftime('%Y-%m-%dT%H:%M:%S')}] Triggering download for schedule: {schedule_id}")
        
        # Build payload
        payload = {
            "url": schedule["url"],
            "audioOnly": schedule.get("audioOnly", False),
            "resolution": schedule.get("resolution", "1080"),
            "isPlaylist": schedule.get("isPlaylist", False),
            "isChannel": schedule.get("isChannel", False),
        }
        
        if schedule.get("path"):
            payload["path"] = schedule["path"]
        
        if schedule.get("maxVideos"):
            payload["maxVideos"] = schedule["maxVideos"]
        
        # Trigger download via API
        try:
            data = json.dumps(payload).encode("utf-8")
            req = urllib.request.Request(API_URL, data=data, headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=10) as response:
                result = json.loads(response.read().decode("utf-8"))
                
                if result.get("success"):
                    print(f"[{time.strftime('%Y-%m-%dT%H:%M:%S')}] Download triggered successfully for schedule: {schedule_id}")
                    
                    # Update schedule
                    interval_ms = schedule["intervalMinutes"] * 60 * 1000
                    schedule["lastRun"] = now
                    schedule["nextRun"] = now + interval_ms
                    updated = True
                else:
                    print(f"[{time.strftime('%Y-%m-%dT%H:%M:%S')}] Failed to trigger download: {result.get('message', 'Unknown error')}")
        except Exception as e:
            print(f"[{time.strftime('%Y-%m-%dT%H:%M:%S')}] Error triggering download: {e}")

if updated:
    try:
        with open(SCHEDULES_FILE, "w") as f:
            json.dump(schedules, f, indent=2)
    except Exception as e:
        print(f"[{time.strftime('%Y-%m-%dT%H:%M:%S')}] Error saving schedules: {e}")
PYTHON_SCRIPT
fi

exit 0
