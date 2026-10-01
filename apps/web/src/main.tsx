import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { startHostClient } from './host-client'

const root = document.getElementById('root')
if (!root) throw new Error('Missing #root element')
startHostClient()
createRoot(root).render(<React.StrictMode><App/></React.StrictMode>)
