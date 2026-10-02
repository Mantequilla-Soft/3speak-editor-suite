import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './App.css'

// Prevent browser-level pinch-to-zoom on mobile (iOS Safari ignores viewport meta)
document.addEventListener('gesturestart', (e) => e.preventDefault())
document.addEventListener('gesturechange', (e) => e.preventDefault())
document.addEventListener('gestureend', (e) => e.preventDefault())

// Block multi-touch zoom on Android and fallback for iOS
document.addEventListener('touchmove', (e) => {
  if (e.touches.length > 1) {
    // Only prevent if target is NOT inside a timeline-content (allow our timeline pinch-zoom)
    if (!e.target.closest('.timeline-content')) {
      e.preventDefault()
    }
  }
}, { passive: false })

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
