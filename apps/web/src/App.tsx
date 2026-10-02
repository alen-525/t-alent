import { useEffect, useMemo, useRef, useState, type FormEvent, type ChangeEvent } from 'react'
import { ArrowUp, ChevronDown, ChevronLeft, ChevronRight, Layers3, Package, SlidersHorizontal, Sparkles, Trash2, Upload, X } from 'lucide-react'
import { AppFrame } from './AppFrame'
import { SettingsPanel } from './SettingsPanel'
import { SegmentedControl } from './primitives/SegmentedControl'
import { Button } from './primitives/Button'
import { AppearanceRow } from './AppearanceRow'
import { FontSizeRow } from './FontSizeRow'
import { SidebarRoot } from './SidebarRoot'
import composerCss from './Composer.module.css'
import { appendTaskEvent, isRunnable, registeredRecord, validateManifest } from './runtime-contract.js'
import type { AgentPackageManifest, HostAdapter, PackageModels, TaskEvent } from './host-adapter'
import './app.css'

type InstalledPackage = { manifest: AgentPackageManifest; runtimeReady: boolean }
function makeConversationId() { return globalThis.crypto?.randomUUID?.() ?? `conversation-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}` }
const PACKAGE_KEY = 'talent.agentPackages.v1'
const STRINGS = {
  en: { newChat: 'New conversation', workspace: 'Workspace', recent: 'Recent', home: 'Home', settings: 'Settings', packages: 'Agent packages', input: 'Message your agent package', noAgentShort: 'Select an agent package', hostOffline: 'Runtime host is disconnected', runningSub: 'Task is running. Stop it to continue.', loadPackage: 'Import package descriptor', selectPackage: 'Select package', appearance: 'Appearance', language: 'Language', fontSize: 'Font size', light: 'Light', dark: 'Dark', system: 'System', packageTitle: 'Agent packages', packageSub: 'Agent packages provide executable model and tool integrations. The framework supplies the host, shared task contract, and conversation interface.', registered: 'Registered', ready: 'Runtime ready', descriptor: 'Package descriptor', choose: 'Choose a JSON descriptor', validate: 'Register descriptor', emptyPackages: 'No packages registered', runtimeUnavailable: 'Package is registered, but no execution runtime is connected.', unsupported: 'Start a host with an explicitly trusted local package path, for example: npm run host -- --package ./packs/<package> --workspace /path/to/workspace', registeredHelp: 'A descriptor registers package metadata only. It does not load or execute package code.', remove: 'Uninstall', languageEnglish: 'English', languageChinese: '简体中文', model:'Model', defaultModel:'Package default', customModel:'Custom model ID', modelLoading:'Loading models…', modelError:'Could not load models. You can use the package default or retry.', modelRetry:'Retry', modelNewChat:'Changing the model starts a new conversation.', customPlaceholder:'Enter model ID (up to 200 characters)', modelIdRequired:'Enter a model ID to use a custom model.', modelTooLong:'Model ID must be 200 characters or fewer.' },
  zh: { newChat: '新建对话', workspace: '工作区', recent: '最近', home: '首页', settings: '设置', packages: 'Agent 包', input: '向 Agent 包发送消息', noAgentShort: '先选择 Agent 包', hostOffline: '运行宿主未连接', runningSub: '任务正在运行，停止后可继续。', loadPackage: '导入包描述', selectPackage: '选择 Agent 包', appearance: '外观', language: '语言', fontSize: '字体大小', light: '浅色', dark: '深色', system: '跟随系统', packageTitle: 'Agent 包', packageSub: 'Agent 包提供模型和工具的可执行接入。本框架提供通用宿主、任务接口和对话界面。', registered: '已登记', ready: '运行时就绪', descriptor: '包描述文件', choose: '选择 JSON 描述文件', validate: '登记描述文件', emptyPackages: '尚未登记 Agent 包', runtimeUnavailable: '包已登记，但没有连接可执行任务的运行时。', unsupported: '请通过显式指定本地可信包路径启动宿主，例如：npm run host -- --package ./packs/<package> --workspace /工作区路径', registeredHelp: '描述文件只登记包元数据，不会加载或执行包代码。', remove: '卸载', languageEnglish: 'English', languageChinese: '简体中文', model:'模型',defaultModel:'包默认',customModel:'自定义模型 ID',modelLoading:'正在加载模型…',modelError:'模型列表加载失败。你仍可使用包默认模型，或重试。',modelRetry:'重试',modelNewChat:'切换模型会新建对话。',customPlaceholder:'输入模型 ID（最多 200 个字符）',modelIdRequired:'请输入自定义模型 ID。',modelTooLong:'模型 ID 不能超过 200 个字符。' }
}
function readStored(): InstalledPackage[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(PACKAGE_KEY) || '[]')
    if (!Array.isArray(value)) return []
    return value.flatMap(row => {
      try { return [registeredRecord(validateManifest(row?.manifest))] } catch { return [] }
    })
  } catch { return [] }
}
export function App() {
  const [page, setPage] = useState<'home'|'conversation'|'settings'|'packages'>('home')
  const [collapsed, setCollapsed] = useState(false)
  const [packages, setPackages] = useState<InstalledPackage[]>(readStored)
  const [selected, setSelected] = useState('')
  const [message, setMessage] = useState('')
  const [models, setModels] = useState<PackageModels>({ models: [] })
  const [modelsLoading, setModelsLoading] = useState(false)
  const [modelsError, setModelsError] = useState('')
  const [modelChoice, setModelChoice] = useState('')
  const [customModel, setCustomModel] = useState('')
  const [usingCustomModel, setUsingCustomModel] = useState(false)
  const modelRequest = useRef(0)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [locale, setLocale] = useState<'en'|'zh'>(() => localStorage.getItem('talent.locale') === 'zh' || (!localStorage.getItem('talent.locale') && navigator.language.startsWith('zh')) ? 'zh' : 'en')
  const [theme, setTheme] = useState(() => localStorage.getItem('talent.theme') || 'system')
  const [fontSize, setFontSize] = useState(() => localStorage.getItem('talent.fontSize') || '14')
  const [adapter, setAdapter] = useState<HostAdapter | undefined>(() => window.talentHostAdapter)
  const [turns, setTurns] = useState<Array<{ role:'user'|'assistant'|'tool'; text:string }>>([])
  const [, setPackageEventDetails] = useState<TaskEvent[]>([])
  const [running, setRunning] = useState(false)
  const [rightbarOpen, setRightbarOpen] = useState(false)
  const [settingsSection, setSettingsSection] = useState('appearance')
  const [descriptorName, setDescriptorName] = useState('')
  const activeRun = useRef<{ adapter: HostAdapter; packageId: string; token: number; taskId: string; cancelInFlight: boolean; streamDone: boolean } | undefined>(undefined)
  const runToken = useRef(0)
  const conversationId = useRef(makeConversationId())
  const t = STRINGS[locale]
  const ready = packages.filter(item => item.runtimeReady)
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => { const resolved = theme === 'system' ? (media.matches ? 'dark' : 'light') : theme; document.documentElement.dataset.theme = resolved; if (resolved === 'dark') document.body.dataset.dsDarkTheme = ''; else delete document.body.dataset.dsDarkTheme }
    apply(); media.addEventListener('change', apply)
    document.documentElement.style.setProperty('--font-size', `${fontSize}px`); localStorage.setItem('talent.theme', theme); localStorage.setItem('talent.fontSize', fontSize)
    return () => media.removeEventListener('change', apply)
  }, [theme,fontSize])
  useEffect(() => { localStorage.setItem('talent.locale', locale); document.documentElement.lang = locale }, [locale])
  useEffect(() => {
    setPackages(old => old.map(item => ({ ...item, runtimeReady:false })))
    setSelected('')
    if (!adapter) return
    let alive = true
    const refresh = () => adapter.listPackages().then(rows => {
      if (!alive) return
      const valid = rows.flatMap(row => {
        try { return [{ manifest:validateManifest(row.manifest), runtimeReady:row.runtimeReady === true }] } catch { return [] }
      })
      setPackages(old => [...valid, ...old.filter(item => !item.runtimeReady && !valid.some(row => row.manifest.id === item.manifest.id))])
    }).catch(() => { if (alive) setPackages(old => old.map(item => ({ ...item, runtimeReady:false }))) })
    void refresh()
    const onHostChange = () => { void refresh(); if (adapter.connected === false && activeRun.current) void cancelActive(false) }
    window.addEventListener('talent:host-ready', onHostChange)
    return () => { alive = false; window.removeEventListener('talent:host-ready', onHostChange) }
  }, [adapter])
  useEffect(() => { const check = () => setAdapter(window.talentHostAdapter); window.addEventListener('talent:host-ready', check); return () => window.removeEventListener('talent:host-ready', check) }, [])
  useEffect(() => { localStorage.setItem(PACKAGE_KEY, JSON.stringify(packages.map(item => ({ manifest: item.manifest, runtimeReady: false })))) }, [packages])
  const selectedPackage = useMemo(() => ready.find(item => item.manifest.id === selected), [ready,selected])
  const hostConnected = Boolean(adapter && adapter.connected !== false)
  const canRun = isRunnable(packages, selected, adapter)
  async function loadModels(packageId: string, currentAdapter: HostAdapter) {
    const requestId = ++modelRequest.current
    if (modelChoice || usingCustomModel) {
      conversationId.current = makeConversationId(); setTurns([]); setPackageEventDetails([]); setNotice(t.modelNewChat)
    }
    setModels({ models: [] }); setModelsError(''); setModelChoice(''); setCustomModel(''); setUsingCustomModel(false); setModelsLoading(false)
    if (!packageId || !packages.some(item => item.manifest.id === packageId && item.runtimeReady) || !currentAdapter.listModels) return
    setModelsLoading(true)
    try {
      const result = await currentAdapter.listModels(packageId)
      if (requestId !== modelRequest.current) return
      setModels({ models: Array.isArray(result.models) ? result.models.filter(model => typeof model?.id === 'string' && model.id.length > 0) : [], defaultModel: result.defaultModel, allowCustomModel: result.allowCustomModel === true })
    } catch (reason) {
      if (requestId !== modelRequest.current) return
      setModelChoice(''); setCustomModel(''); setUsingCustomModel(false)
      setModelsError(reason instanceof Error ? reason.message : String(reason))
    } finally { if (requestId === modelRequest.current) setModelsLoading(false) }
  }
  useEffect(() => {
    if (selectedPackage && adapter) void loadModels(selectedPackage.manifest.id, adapter)
    else { ++modelRequest.current; setModels({ models: [] }); setModelsLoading(false); setModelsError('') }
    return () => { ++modelRequest.current }
  }, [selectedPackage?.manifest.id, adapter])
  function changeModel(change: () => void) {
    if (running || activeRun.current) return
    change()
    conversationId.current = makeConversationId(); setTurns([]); setPackageEventDetails([]); setError(''); setNotice(t.modelNewChat)
  }
  async function cancelActive(showCancellation = false): Promise<boolean> {
    const active = activeRun.current
    if (active) {
      if (!active.adapter.cancelTask) { setError('The host does not support task cancellation.'); return false }
      active.cancelInFlight = true
      try { await active.adapter.cancelTask(active.taskId) } catch (reason) {
        active.cancelInFlight = false
        setError(reason instanceof Error ? reason.message : String(reason))
        if (active.streamDone && activeRun.current === active) { activeRun.current = undefined; setRunning(false) }
        return false
      }
      active.cancelInFlight = false
      runToken.current += 1
    }
    if (activeRun.current === active) activeRun.current = undefined
    setRunning(false)
    if (showCancellation) setTurns(old => appendTaskEvent(old, { type:'cancelled' }))
    return true
  }
  useEffect(() => {
    const active = activeRun.current
    if (active && (active.adapter !== adapter || active.packageId !== selected)) void cancelActive(false)
  }, [adapter, selected])
  useEffect(() => () => {
    const active = activeRun.current
    if (active) {
      runToken.current += 1
      activeRun.current = undefined
      if (active.adapter.cancelTask) void active.adapter.cancelTask(active.taskId).catch(()=>{})
    }
  }, [])
  async function addDescriptor(event: ChangeEvent<HTMLInputElement>) {
    setError(''); setNotice('')
    const file = event.target.files?.[0]; if (!file) return
    setDescriptorName(file.name)
    try {
      const manifest = validateManifest(JSON.parse(await file.text()))
      if (packages.some(item => item.manifest.id === manifest.id)) throw new Error(`Package id “${manifest.id}” is already registered.`)
      await adapter?.registerPackage(manifest)
      setPackages(old => [...old, registeredRecord(manifest)]); setNotice(t.registeredHelp)
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    event.target.value = ''
  }
  async function uninstall(id: string) {
    try { if (activeRun.current?.packageId === id && !await cancelActive(false)) return; await adapter?.uninstallPackage(id); setPackages(old => old.filter(item => item.manifest.id !== id)); if (selected === id) setSelected('') } catch (reason) { setError(String(reason)) }
  }
  async function selectPackage(id: string) {
    if (id === selected) return
    if (activeRun.current && !await cancelActive(false)) return
    conversationId.current = makeConversationId()
    ++modelRequest.current; setModels({ models: [] }); setModelsError(''); setModelsLoading(Boolean(adapter?.listModels && id)); setModelChoice(''); setCustomModel(''); setUsingCustomModel(false)
    setSelected(id); setTurns([]); setPackageEventDetails([]); setMessage(''); setError(''); setNotice('')
  }
  async function startNewConversation() {
    if (activeRun.current && !await cancelActive(false)) return
    conversationId.current = makeConversationId()
    setTurns([]); setPackageEventDetails([]); setMessage(''); setError(''); setNotice(''); setPage('conversation')
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); setError('')
    if (!message.trim() || running || activeRun.current || modelsLoading) return
    if (!canRun || !selectedPackage || !adapter) { setError(t.unsupported); return }
    const input = message.trim()
    const runAdapter = adapter
    const packageId = selectedPackage.manifest.id
    const model = usingCustomModel ? customModel.trim() : modelChoice
    if (usingCustomModel && !model) { setError(t.modelIdRequired); return }
    if (usingCustomModel && model.length > 200) { setError(t.modelTooLong); return }
    const token = ++runToken.current
    const taskId = token.toString(36) + '-' + Date.now().toString(36)
    const active = { adapter:runAdapter, packageId, token, taskId, cancelInFlight:false, streamDone:false }
    activeRun.current = active
    setTurns(old => [...old, { role:'user', text:input }]); setMessage(''); setRunning(true); setPage('conversation')
    try {
      for await (const event of runAdapter.executeTask({ input, packageId, taskId, sessionId:conversationId.current, ...(model ? { model } : {}) })) {
        if (runToken.current !== token) break
        if (event.type === 'reasoning' || event.type === 'harness-event') setPackageEventDetails(old => [...old, event])
        setTurns(old => appendTaskEvent(old, event))
        if (event.type === 'error') setError(event.message)
        if (event.type === 'error' || event.type === 'cancelled') break
      }
    } catch (reason) { if (runToken.current === token) { const detail = reason instanceof Error ? reason.message : String(reason); setError(detail); setTurns(old => appendTaskEvent(old, { type:'error', message:detail })) } }
    finally { active.streamDone = true; if (runToken.current === token && !active.cancelInFlight) { activeRun.current = undefined; setRunning(false) } }
  }
  const modelPicker = selectedPackage ? { models, loading:modelsLoading, error:modelsError, choice:modelChoice, custom:customModel, usingCustom:usingCustomModel, disabled:running, valid:!usingCustomModel||Boolean(customModel.trim()&&customModel.trim().length<=200), notice:turns.length>0?t.modelNewChat:'', onChoice:(value:string)=>changeModel(()=>{setUsingCustomModel(false);setModelChoice(value)}), onCustomMode:(value:boolean)=>changeModel(()=>setUsingCustomModel(value)), onCustom:(value:string)=>changeModel(()=>setCustomModel(value)), onRetry:()=>{if(adapter) void loadModels(selectedPackage.manifest.id,adapter)}, labels:t } : undefined
  const sidebar = ({ collapsed: compact, width, onToggle }: { collapsed: boolean; width:number; onToggle: () => void }) => <SidebarRoot collapsed={compact} width={width} onToggle={onToggle} onNewSession={startNewConversation} onHome={()=>setPage('home')} activePanel={page} panels={[{id:'home',label:t.home,icon:<Layers3 size={17}/>,onSelect:()=>setPage('home')},{id:'packages',label:t.packages,icon:<Package size={17}/>,onSelect:()=>setPage('packages')}]} onSettings={()=>setPage('settings')} labels={{newSession:t.newChat,openSidebar:locale==='zh'?'展开侧栏':'Expand sidebar',collapseSidebar:locale==='zh'?'折叠侧栏':'Collapse sidebar',panels:locale==='zh'?'导航':'Navigation',settings:t.settings,packages:t.packages,home:t.home,workspace:t.workspace,recent:t.recent,noConversations:locale==='zh'?'暂无对话':'No conversations yet'}} />
  const settingsSections = [
    { id:'appearance', label:t.appearance, icon:<Sparkles size={15}/>, content:<div className="settings-section"><AppearanceRow value={theme} onChange={setTheme} labels={{title:t.appearance,light:t.light,dark:t.dark,system:t.system}}/><FontSizeRow value={Number(fontSize)} onChange={value=>setFontSize(String(value))} labels={{title:t.fontSize,description:locale==='zh'?'调整界面文字大小':'Adjust the interface text size',increase:locale==='zh'?'增大字体':'Increase font size',decrease:locale==='zh'?'减小字体':'Decrease font size',unit:'px'}}/></div> },
    { id:'general', label:t.language, icon:<SlidersHorizontal size={15}/>, content:<div className="settings-section"><label>{t.language}</label><SegmentedControl id="language" label={t.language} value={locale} options={[{value:'en',label:'English'},{value:'zh',label:'简体中文'}]} onChange={setLocale}/></div> },
    { id:'packages', label:t.packages, icon:<Package size={15}/>, content:<div className="settings-section"><label>{t.packages}</label><p>{packages.length} {locale==='zh'?'个已登记':'registered'}</p>{!hostConnected&&<p>{t.unsupported}</p>}<Button variant="primary" size="sm" icon={<Package size={15}/>} onClick={()=>{setPage('packages');setSettingsSection('appearance')}}>{t.loadPackage}</Button></div> },
  ]
  return <AppFrame sidebar={sidebar} sidebarCollapsed={collapsed} onToggleSidebar={() => setCollapsed(value=>!value)} rightbarOpen={rightbarOpen} rightbar={<aside className="right-panel"><div className="right-panel-head"><b>{t.selectPackage}</b><button className="icon-btn" onClick={()=>setRightbarOpen(false)} aria-label="Close panel"><X size={16}/></button></div>{packages.length===0?<p>{t.emptyPackages}</p>:packages.map(item=><button className="right-package" key={item.manifest.id} disabled={!item.runtimeReady} aria-pressed={selected===item.manifest.id} onClick={()=>{if(item.runtimeReady){selectPackage(item.manifest.id);setRightbarOpen(false)}}}><Package size={16}/><span>{item.manifest.name}</span><small>{item.runtimeReady?t.ready:t.registered}</small></button>)}<p className="right-panel-note">{t.registeredHelp}</p></aside>} main={<main className="main-area">
    <header className="topbar"><div className="breadcrumb">{page==='home'?t.home:page==='settings'?t.settings:page==='packages'?t.packages:t.newChat}</div><div className="top-actions"><button className="top-pill" onClick={() => setPage('packages')}><Package size={15}/>{selectedPackage?.manifest.name || t.selectPackage}<ChevronDown size={13}/></button><button className="icon-btn" aria-label="Package panel" onClick={() => setRightbarOpen(value=>!value)}><Layers3/></button><button className="icon-btn" aria-label="Preferences" onClick={() => setPage('settings')}><SlidersHorizontal/></button></div></header>
    {page==='home'&&<div className="home-page"><Composer message={message} setMessage={setMessage} submit={submit} enabled={canRun&&!running&&!modelsLoading} running={running} onStop={()=>void cancelActive(true)} placeholder={t.input} disabledHint={selectedPackage&&!hostConnected?t.hostOffline:t.noAgentShort} runningHint={t.runningSub} modelPicker={modelPicker} /></div>}
    {page==='conversation'&&<div className="conversation-page"><div className="turn-list">{turns.map((turn,index)=><article key={index} className={`turn ${turn.role}`}><span>{turn.role==='user'?'You':turn.role==='assistant'?'Agent':'Tool'}</span><p>{turn.text}</p></article>)}</div><Composer message={message} setMessage={setMessage} submit={submit} enabled={canRun&&!running&&!modelsLoading} running={running} onStop={()=>void cancelActive(true)} placeholder={t.input} disabledHint={selectedPackage&&!hostConnected?t.hostOffline:t.noAgentShort} runningHint={t.runningSub} modelPicker={modelPicker} /></div>}
    <SettingsPanel open={page==='settings'} onClose={()=>setPage('home')} title={t.settings} sections={settingsSections} selectedId={settingsSection} onSelect={setSettingsSection} closeLabel={locale==='zh'?'关闭设置':'Close settings'} />
    {page==='packages'&&<section className="packages-page"><div className="page-heading"><div><h1>{t.packageTitle}</h1><p className="page-subtitle">{t.packageSub}</p></div><label className="primary-btn upload-btn"><Upload size={16}/>{t.loadPackage}<input type="file" accept="application/json,.json" onChange={addDescriptor}/></label></div><div className="adapter-state"><span className={hostConnected?'status-dot online':'status-dot'}></span>{hostConnected?(locale==='zh'?'已连接运行宿主':'Runtime host connected'):t.unsupported}<button className="icon-btn" aria-label="Toggle package panel" onClick={()=>setRightbarOpen(value=>!value)}>{rightbarOpen?<ChevronRight/>:<ChevronLeft/>}</button></div>{notice&&<p className="notice">{notice}</p>}{error&&<p className="error-message" role="alert">{error}</p>}
      {packages.length===0?<div className="package-empty"><Package size={25}/><b>{t.emptyPackages}</b><span>{t.registeredHelp}</span></div>:<div className="package-list">{packages.map(item=><article className="package-card" key={item.manifest.id}><div className="package-icon"><Package size={20}/></div><div className="package-info"><div className="package-name">{item.manifest.name}<span className={`badge ${item.runtimeReady?'ready':''}`}>{item.runtimeReady?t.ready:t.registered}</span></div><div className="package-meta">{item.manifest.id} <span>·</span> v{item.manifest.version}</div>{item.manifest.description&&<p>{item.manifest.description}</p>}</div>{item.runtimeReady&&<button className={`select-btn ${selected===item.manifest.id?'chosen':''}`} onClick={()=>selectPackage(item.manifest.id)}>{selected===item.manifest.id?(locale==='zh'?'已选择':'Selected'):t.selectPackage}</button>}<button className="icon-btn remove-btn" title={t.remove} onClick={()=>void uninstall(item.manifest.id)}><Trash2 size={16}/></button></article>)}</div>}
      <div className="manifest-note"><b>{t.descriptor}</b><span>{descriptorName || t.choose}</span><small>{t.registeredHelp}</small></div></section>}
    {error&&page!=='packages'&&<div className="toast-error" role="alert"><span>{error}</span><button onClick={()=>setError('')}><X size={14}/></button></div>}
  </main>} />
}

function Composer({ message, setMessage, submit, enabled, running = false, onStop, placeholder, disabledHint, runningHint, modelPicker }: { message: string; setMessage: (value:string)=>void; submit: (event:FormEvent)=>void; enabled:boolean; running?:boolean; onStop?:()=>void; placeholder:string; disabledHint:string; runningHint:string; modelPicker?: { models:PackageModels; loading:boolean; error:string; choice:string; custom:string; usingCustom:boolean; disabled:boolean; valid:boolean; notice:string; onChoice:(value:string)=>void; onCustomMode:(value:boolean)=>void; onCustom:(value:string)=>void; onRetry:()=>void; labels:typeof STRINGS['en'] | typeof STRINGS['zh'] } }) {
  const hint = running ? runningHint : disabledHint
  return <form className={composerCss.root} onSubmit={submit}><div className={`${composerCss.card} ${enabled?'':composerCss.disabled}`}>
    <textarea className={composerCss.input} aria-label={placeholder} value={message} onChange={event=>setMessage(event.target.value)} placeholder={modelPicker?.loading?modelPicker.labels.modelLoading:enabled?placeholder:hint} disabled={!enabled} rows={2}/><div className={composerCss.row}>{modelPicker&&<div className={composerCss.modelArea}><label className={composerCss.modelLabel} htmlFor="composer-model">{modelPicker.labels.model}</label><select id="composer-model" className={composerCss.modelSelect} aria-label={modelPicker.labels.model} disabled={modelPicker.disabled||modelPicker.loading} value={modelPicker.usingCustom?'__custom__':modelPicker.choice} onChange={event=>event.target.value==='__custom__'?modelPicker.onCustomMode(true):modelPicker.onChoice(event.target.value)}>
      <option value="" title={modelPicker.models.defaultModel}>{modelPicker.labels.defaultModel}</option>
      {modelPicker.models.models.map(model=><option key={model.id} value={model.id} title={model.id}>{model.name||model.id}</option>)}
      {modelPicker.models.allowCustomModel&&<option value="__custom__">{modelPicker.labels.customModel}</option>}
    </select>{modelPicker.usingCustom&&<input className={composerCss.modelInput} aria-label={modelPicker.labels.customModel} placeholder={modelPicker.labels.customPlaceholder} value={modelPicker.custom} maxLength={200} disabled={modelPicker.disabled} onChange={event=>modelPicker.onCustom(event.target.value)}/>}</div>}<div className={composerCss.trailing}>{running?<button className={composerCss.primary} aria-label="Stop task" type="button" onClick={onStop}>■</button>:<button className={composerCss.primary} aria-label="Send" type="submit" disabled={!enabled||!message.trim()||Boolean(modelPicker&&!modelPicker.valid)}><ArrowUp size={17}/></button>}</div></div>{modelPicker?.loading&&<small className={composerCss.modelHint}>{modelPicker.labels.modelLoading}</small>}{modelPicker?.error&&<div className={composerCss.modelError} role="status"><span>{modelPicker.labels.modelError} {modelPicker.error}</span><button type="button" onClick={modelPicker.onRetry} disabled={modelPicker.loading||modelPicker.disabled}>{modelPicker.labels.modelRetry}</button></div>}{modelPicker?.usingCustom&&!modelPicker.valid&&<small className={composerCss.modelHint}>{modelPicker.custom.trim()?modelPicker.labels.modelTooLong:modelPicker.labels.modelIdRequired}</small>}{modelPicker?.notice&&<small className={composerCss.modelHint}>{modelPicker.notice}</small>}</div></form>
}
