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
- **giphy.gif** - Visual asset displayed on blocked page

### Extension Popup

- **exports.html** - Extension popup interface showing current site status and usage statistics
- **exports.js** - Handles export functionality, usage display, and folder selection

### File System Access

- **offscreen.html** - Offscreen document for File System Access API operations
- **offscreen.js** - Handles persistent file writing operations in background
- **folder-picker.html** - Dedicated page for folder selection with user activation
- **folder-picker.js** - Manages folder selection and persistent permission requests

## Functionality Summary

### background.js
- Manages three blocking policies:
  - **Social media** (Reddit, Twitter/X): Always blocked, 3-minute grace periods
  - **Streaming** (YouTube, Disney+, etc.): Blocked during work hours (Mon-Fri 9am-6pm) after 1-hour daily allowance, 30-minute lunch sessions available (12-2pm), 5-minute grace periods
  - **Hacker News**: 3 visits per 3-hour window, 5-minute visit duration, 5-minute grace periods
- Tracks time spent on all websites
- Stores usage data in Chrome storage and exports to file system
- Handles session management for temporary access (grace periods, lunch, visits)
- Auto-exports CSV files every 5 minutes to selected folder
- Manages alarms for midnight rollovers and periodic saves

### content.js
- Checks website access permissions with background service
- Redirects to blocked page when access is denied
- Sets timers for session expiry
- Listens for session expiration messages

### blocked.js
- Displays blocking reason and rules for each policy
- Generates random codes for grace period verification (prevents copy/paste)
- Handles grace period unlock (3 minutes for social, 5 minutes for streaming/HN)
- Manages lunch sessions (30-minute access during lunch hours for streaming)
- Manages Hacker News visits (5-minute limited visits)

### exports.js
- Displays current site status and blocking information
- Shows daily usage statistics in table format
- Manages CSV export to selected folder
- Handles folder selection and permission management
- Auto-saves usage data every 5 minutes when configured

### offscreen.js
- Provides File System Access API operations in offscreen document context
- Handles persistent permission for background file writes
- Manages IndexedDB storage for directory handles

### folder-picker.js
- Provides dedicated page for folder selection with proper user activation
- Manages two-step process: folder selection and persistent permission
- Stores directory handles in IndexedDB

## Data Storage

- Usage data stored in Chrome local storage
- Directory handles stored in IndexedDB
- CSV files exported directly to user-selected folder
- We want to fail fast. No limping along in the case of errors. Just fail.
- Never ever add comments describing what changes you made.