import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './theme.css'
import './app.css'
import './cand.css'
import './aibadge.css'
import './modelpicker.css'
import './effort.css'
import './perm.css'
import './chat.css'
import './ui.css'
import './v6.css'
import './motion.css'
import { App } from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode><App /></StrictMode>,
)
