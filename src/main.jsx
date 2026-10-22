import React, { Suspense, lazy } from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './App.css'
import './utils/editorAuth' // listens for the 3Speak sign-in from the first message on

// Two entry modes. Default: the Shorts editor (App). ?mode=ads: the Ad Wizard, its own shell and its own
// code chunk (src/adwizard), so the editor does not load or change because of it.
const AdWizard = lazy(() => import('./adwizard/AdWizard.jsx'))
const MODE = new URLSearchParams(window.location.search).get('mode')

// Only allow usage inside an iframe (embedded by 3speak.tv)
if (window.self === window.top) throw new Error('iframe-only')

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
    {MODE === 'ads'
      ? <Suspense fallback={null}><AdWizard /></Suspense>
      : <App />}
  </React.StrictMode>,
)
