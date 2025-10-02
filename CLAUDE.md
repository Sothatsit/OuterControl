# Outer-Control

A Chrome extension (Manifest V3) for blocking distracting websites and tracking web usage.

## Project Structure

### Core Files

- **manifest.json** - Chrome extension manifest defining permissions, content scripts, and web resources
- **background.js** - Service worker handling blocking logic, session management, and usage tracking
- **content.js** - Content script injected into monitored sites to check access and redirect if blocked
- **blocked.html** - Page displayed when a site is blocked
- **blocked.js** - Handles user interactions on the blocked page (grace periods, lunch sessions)
- **blocked.css** - Styles for the blocked page

### Extension Popup

- **popup.html** - Extension popup interface showing current site status and usage statistics
- **popup.js** - Handles ZIP export and usage display
- **popup.css** - Popup styles

### Offscreen Document

- **offscreen.html** - Offscreen document for persistence operations
- **offscreen.js** - Requests persistent storage permission at startup

### Shared Resources

- **common/base.css** - Shared CSS variables and base styles
- **common/time.js** - Time formatting and date utilities
- **common/idb.js** - IndexedDB storage operations
- **common/jszip.min.js** - Third-party library for ZIP file generation
- **res/giphy.gif** - Block page GIF
- **res/logo.png** - Extension logo

## Functionality Summary

### background.js
- Manages three blocking policies:
  - **Social media** (Reddit, Twitter/X): Always blocked, 5-minute grace periods
  - **Streaming** (YouTube, Disney+, etc.): Blocked during work hours (Mon-Fri 9am-6pm) after 1-hour daily allowance, 30-minute lunch sessions available (12-2pm), 5-minute grace periods
  - **Hacker News**: 3 visits per 3-hour window, 5-minute visit duration, 5-minute grace periods
- Tracks time spent on all websites
- Stores usage data and state in IndexedDB
- Handles session management for temporary access (grace periods, lunch, visits)
- Auto-saves state every 5 minutes
- Manages alarms for midnight rollovers and periodic saves

### content.js
- Checks website access permissions with background service
- Redirects to blocked page when access is denied
- Sets timers for session expiry
- Listens for session expiration messages

### blocked.js
- Displays blocking reason and rules for each policy
- Generates random codes for grace period verification (prevents copy/paste)
- Handles grace period unlock (5 minutes for all policies)
- Manages lunch sessions (30-minute access during lunch hours for streaming)

### popup.js
- Displays current site status and blocking information
- Shows daily usage statistics in table format
- Exports all usage data as a ZIP file containing CSV files for each day

### offscreen.js
- Requests persistent storage permission at startup
- Sends result back to background script

## Data Storage

- All data stored in IndexedDB (sessions, quotas, usage data)
- State saved every 5 minutes and on suspend
- Usage data exported as ZIP download with CSV files

## Development Guidelines

- Fail fast - no limping along with errors
- Never add comments describing what changes you made