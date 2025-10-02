# Outside-Control

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

- **exports.html** - Extension popup interface showing current site status and usage statistics
- **exports.js** - Handles export functionality, usage display, and folder selection

### File System Access

- **offscreen.html** - Offscreen document for File System Access API operations
- **offscreen.js** - Handles persistent file writing operations in background
- **folder-picker.html** - Dedicated page for folder selection with user activation
- **folder-picker.js** - Manages folder selection and persistent permission requests

## Functionality Summary

### background.js
- Manages three blocking policies: social media (always blocked), streaming (work hours), and Hacker News (quota-based)
- Tracks time spent on all websites
- Stores usage data in Chrome storage
- Handles session management for temporary access
- Auto-exports CSV files every 5 minutes
- Manages alarms for midnight rollovers and periodic saves

### content.js
- Checks website access permissions with background service
- Redirects to blocked page when access is denied
- Sets timers for session expiry
- Listens for session expiration messages

### blocked.js
- Displays blocking reason and rules
- Generates random codes for grace period verification
- Handles grace period unlock (3-minute access)
- Manages lunch sessions (30-minute access during lunch hours)
- Manages Hacker News visits (15-minute limited visits)

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