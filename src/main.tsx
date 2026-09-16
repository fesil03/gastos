import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { initPwa } from './pwa'
import './index.css'
import App from './App'

initPwa()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
