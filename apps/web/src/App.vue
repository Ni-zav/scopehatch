<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { ApiError, createHttpApi } from './api'
import { beginSignIn, finishSignIn, getAccessToken, isSignedIn, oidcConfigured, signOut } from './oidc'
import { DemoApi, fixtureProjectId, type FixturePersona } from './demo'
import type { AuditEvent, Catalog, Deliverable, ProjectPage, ProposalMetadata, ProposalExport, ScopehatchApi, Snapshot, SuggestionResponse } from './types'

type EditableLine = { key: number; serviceId: string; quantity: string; evidence: string; source: 'brief' | 'manual'; clientDescription: string }
type RateLine = { key: number; id: string; label: string; price: string }
const isDemo = import.meta.env.VITE_SCOPEHATCH_DEMO === 'true'
const fixture = isDemo ? new DemoApi() : null
// Production has no implicit session, hardcoded bearer token, tenant header or role override.
// The integrator supplies a verified OIDC token provider here after configuring auth.
const selectedWorkspace = ref(sessionStorage.getItem('scopehatch.workspace') ?? '')
const api: ScopehatchApi = fixture ?? createHttpApi({
  baseUrl: import.meta.env.VITE_SCOPEHATCH_API_BASE_URL || '',
  getAccessToken,
  getWorkspaceId: () => selectedWorkspace.value
})
const authenticated = ref(isDemo || isSignedIn())
const oidcReady = isDemo || oidcConfigured()
const persona = ref<FixturePersona>('operator')
const view = ref<'index' | 'workbench' | 'new' | 'catalog'>('index')
const projectIdInput = ref('')
const projectPage = ref<ProjectPage | null>(null)
const pageCursors = ref<(string | null)[]>([null])
const pageNumber = ref(0)
const listBusy = ref(false)
const rateRows = ref<RateLine[]>([])
const catalogBaseVersion = ref(0)
const catalogCurrency = ref('IDR')
const catalogDirty = ref(false)
const catalogSaving = ref(false)
const ownerDenied = ref(false)
const metadata = ref<ProposalMetadata>({overview:'',assumptions:[],exclusions:[],commercialTerms:[]})
const assumptionsText = ref('')
const exclusionsText = ref('')
const commercialTermsText = ref('')
const currentId = ref('')
const catalogs = ref<Catalog[]>([])
const snapshot = ref<Snapshot | null>(null)
const lines = ref<EditableLine[]>([])
const unknowns = ref('')
const creatingTitle = ref('')
const creatingBrief = ref('')
const loading = ref(true)
const busy = ref(false)
const error = ref('')
const notice = ref('')
const activeEvidence = ref('')
const draftDirty = ref(false)
const showTimeline = ref(false)
const events = ref<AuditEvent[]>([])
const cursor = ref<string | null>(null)
const proposal = ref<ProposalExport | null>(null)
const proposalBusy = ref(false)
const suggestionBusy = ref(false)
const suggestion = ref<SuggestionResponse | null>(null)
let rowKey = 0

const catalog = computed(() => catalogs.value[0])
const scope = computed(() => snapshot.value?.latestScope)
const estimate = computed(() => {
  const value = snapshot.value?.latestEstimate
  return value && scope.value && value.scopeRevision === scope.value.revision &&
    value.catalogVersion === catalog.value?.version ? value : null
})
const review = computed(() => snapshot.value?.review)
const reviewCurrent = computed(() => Boolean(review.value && scope.value &&
  review.value.scopeRevision === scope.value.revision &&
  review.value.catalogVersion === catalog.value?.version))
const superseded = computed(() => Boolean(review.value && !reviewCurrent.value))
const approved = computed(() => reviewCurrent.value && review.value?.state === 'approved' &&
  estimate.value?.state === 'ready' && !draftDirty.value)
const pending = computed(() => reviewCurrent.value && review.value?.state === 'pending')
const blocked = computed(() => estimate.value?.state === 'blocked')
const canEdit = computed(() => isDemo ? persona.value === 'operator' || persona.value === 'owner' : authenticated.value)
const canManageCatalog = computed(() => authenticated.value && !ownerDenied.value && (!isDemo || persona.value === 'owner'))
const hasProject = computed(() => view.value === 'workbench' && Boolean(snapshot.value))
const localInvalid = computed(() => lines.value.some(l => {
  const q = String(l.quantity ?? '').trim()
  return !l.serviceId || (q !== '' && (!Number.isSafeInteger(Number(q)) || Number(q) < 1)) ||
    (l.source === 'brief' && (!l.evidence.trim() || !(snapshot.value?.project.brief ?? '').toLowerCase().includes(l.evidence.trim().toLowerCase())))
}))
const status = computed(() => {
  if (draftDirty.value) return { label: 'Unsaved changes', tone: 'warning' }
  if (!scope.value) return { label: 'Needs scope', tone: 'neutral' }
  if (superseded.value) return { label: 'Prior review superseded', tone: 'warning' }
  if (approved.value) return { label: 'Approved', tone: 'good' }
  if (pending.value) return { label: 'Pending review', tone: 'info' }
  if (blocked.value) return { label: 'Pricing blocked', tone: 'warning' }
  if (estimate.value?.state === 'ready') return { label: 'Ready for review', tone: 'good' }
  return { label: 'Not estimated', tone: 'neutral' }
})
const focusSegments = computed(() => {
  const brief = snapshot.value?.project.brief ?? ''
  const match = activeEvidence.value.trim()
  const offset = match ? brief.toLowerCase().indexOf(match.toLowerCase()) : -1
  if (offset < 0) return { before: brief, match: '', after: '' }
  return { before: brief.slice(0, offset), match: brief.slice(offset, offset + match.length), after: brief.slice(offset + match.length) }
})
const currencyDigits: Record<string, number> = { IDR: 0, JPY: 0, KRW: 0, VND: 0, USD: 2, EUR: 2, GBP: 2, SGD: 2, AUD: 2 }
function money(minor: number | null | undefined, currency = catalog.value?.currency ?? 'IDR') {
  if (minor == null) return 'Not priced'
  const digits = currencyDigits[currency]
  if (digits === undefined) return String(minor) + ' ' + currency + ' minor units'
  return new Intl.NumberFormat('en-ID', { style: 'currency', currency, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(minor / Math.pow(10, digits))
}
function showError(cause: unknown) {
  const issue = cause instanceof ApiError ? cause : null
  if (issue?.status === 401 && !isDemo) { signOut(); authenticated.value = false; projectPage.value = null; snapshot.value = null }
  error.value = issue ? issue.message + (issue.requestId ? ' (Request ' + issue.requestId + ')' : '') :
    cause instanceof Error ? cause.message : 'An unexpected error occurred.'
}
function clearFeedback() { error.value = ''; notice.value = '' }
function edit() { draftDirty.value = true; proposal.value = null; notice.value = '' }
function hydrateDraft() {
  lines.value = (scope.value?.deliverables ?? []).map(item => ({
    key: ++rowKey, serviceId: item.serviceId, quantity: item.quantity === null ? '' : String(item.quantity),
    evidence: item.evidence, source: item.source, clientDescription: item.clientDescription ?? ''
  }))
  unknowns.value = scope.value?.unknowns.join('\n') ?? ''
  metadata.value = {
    overview:scope.value?.proposal?.overview ?? '',
    assumptions:[...(scope.value?.proposal?.assumptions ?? [])],
    exclusions:[...(scope.value?.proposal?.exclusions ?? [])],
    commercialTerms:[...(scope.value?.proposal?.commercialTerms ?? [])]
  }
  assumptionsText.value = metadata.value.assumptions.join('\n')
  exclusionsText.value = metadata.value.exclusions.join('\n')
  commercialTermsText.value = metadata.value.commercialTerms.join('\n')
  activeEvidence.value = ''
  draftDirty.value = false
}
function addLine() {
  lines.value.push({ key: ++rowKey, serviceId: catalog.value?.services[0]?.id ?? '', quantity: '', evidence: '', source: 'manual', clientDescription: '' })
  edit()
}
function removeLine(key: number) { lines.value = lines.value.filter(line => line.key !== key); edit() }
function serviceName(id: string) { return catalog.value?.services.find(s => s.id === id)?.label ?? id }
function servicePrice(id: string) { return money(catalog.value?.services.find(s => s.id === id)?.unitPriceMinor) }
async function loadTimeline(append = false) {
  if (!currentId.value) return
  try {
    const page = await api.audit(currentId.value, append ? cursor.value ?? undefined : undefined, 20)
    events.value = append ? [...events.value, ...page.items] : page.items
    cursor.value = page.nextCursor
  } catch (cause) {
    showError(cause)
  }
}
async function loadProject(id: string) {
  clearFeedback()
  loading.value = true
  try {
    const result = await api.project(id)
    currentId.value = id
    projectIdInput.value = id
    snapshot.value = result
    view.value = 'workbench'
    proposal.value = null
    suggestion.value = null
    hydrateDraft()
    await loadTimeline()
  } catch (cause) { showError(cause) }
  finally { loading.value = false }
}
async function reload(message = '') {
  if (!currentId.value) return
  const result = await api.project(currentId.value)
  snapshot.value = result
  hydrateDraft()
  proposal.value = null
  suggestion.value = null
  await loadTimeline()
  notice.value = message
}
async function run(operation: () => Promise<void>) {
  clearFeedback()
  busy.value = true
  try { await operation() } catch (cause) { showError(cause) }
  finally { busy.value = false }
}
function changePersona(next: FixturePersona) {
  if (!fixture) return
  fixture.selectPersona(next)
  persona.value = next
  clearFeedback()
  notice.value = 'Fixture identity changed. No real authentication occurred.'
}
async function newProject() {
  if (!creatingTitle.value.trim() || !creatingBrief.value.trim()) {
    error.value = 'Enter a project title and paste an original client brief.'
    return
  }
  await run(async () => {
    const project = await api.createProject({ title: creatingTitle.value.trim(), brief: creatingBrief.value })
    creatingTitle.value = ''
    creatingBrief.value = ''
    await loadProject(project.id)
    await loadIndex()
    notice.value = 'Original brief saved. Add scoped deliverables to begin.'
  })
}
async function requestSuggestions() {
  if(!currentId.value || !api.suggestions || draftDirty.value)return
  clearFeedback()
  suggestion.value=null
  suggestionBusy.value=true
  try {
    const result=await api.suggestions(currentId.value,scope.value?.revision)
    // A suggestion is advisory. Never mutate an approved record or catalog here.
    for(const item of result.suggestion.suggestedDeliverables){
      if(!catalog.value?.services.some(x=>x.id===item.serviceId))
        throw new ApiError(422,'UNTRUSTED_SUGGESTION','The suggested service is absent from the trusted catalog.')
      if(item.evidence){
        const brief=snapshot.value?.project.brief ?? ''
        if(brief.slice(item.evidence.start,item.evidence.end)!==item.evidence.quote)
          throw new ApiError(422,'UNTRUSTED_SUGGESTION','The suggested evidence does not match the original brief.')
      }
    }
    suggestion.value=result
  }catch(cause){showError(cause)}
  finally{suggestionBusy.value=false}
}
function applySuggestionsToDraft(){
  if(!suggestion.value||draftDirty.value||!catalog.value||!snapshot.value)return
  const source=snapshot.value.project.brief
  const accepted=suggestion.value.suggestion.suggestedDeliverables.map(item=>{
    const evidence=item.evidence
    const quote=evidence && source.slice(evidence.start,evidence.end)===evidence.quote
      ? evidence.quote : null
    return {
      key:++rowKey,serviceId:item.serviceId,
      quantity:quote && item.quantity!==null ? String(item.quantity) : '',
      evidence:quote??'AI suggestion without verifiable source evidence — confirm manually',
      source:quote?'brief' as const:'manual' as const, clientDescription: ''
    }
  })
  if(!accepted.length)return
  // Replaces only local unsaved draft on an explicit operator action.
  lines.value=accepted
  unknowns.value=suggestion.value.suggestion.unknowns.join('\n')
  suggestion.value=null
  edit()
  notice.value='Suggestion copied to your local draft. Verify it and save a new immutable revision; no approval transferred.'
}
async function saveScope() {
  if (localInvalid.value) { error.value = 'Fix invalid quantities and add brief citations before saving.'; return }
  if (!currentId.value || !catalog.value) return
  const targetId = currentId.value
  await run(async () => {
    const deliverables: Deliverable[] = lines.value.map(l => ({
      serviceId: l.serviceId, quantity: String(l.quantity ?? '').trim() === '' ? null : Number(l.quantity),
      evidence: l.evidence.trim(), source: l.source,
      ...(l.clientDescription.trim() ? { clientDescription: l.clientDescription } : {})
    }))
    const unknownList = unknowns.value.split('\n').map(s => s.trim()).filter(Boolean)
    const proposalMetadata: ProposalMetadata = {
      overview: metadata.value.overview,
      assumptions: parseLines(assumptionsText.value),
      exclusions: parseLines(exclusionsText.value),
      commercialTerms: parseLines(commercialTermsText.value)
    }
    validateProposal(proposalMetadata, deliverables)
    // Sprint 02 metadata is additive. Omit absent optional fields so the
    // unchanged Sprint 01 workflow remains operable until the API PR lands.
    const hasProposal = Boolean(proposalMetadata.overview || proposalMetadata.assumptions.length ||
      proposalMetadata.exclusions.length || proposalMetadata.commercialTerms.length)
    const next = await api.createScope(targetId, { deliverables, unknowns: unknownList,
      ...(hasProposal ? {proposal:proposalMetadata} : {}) })
    await api.estimate(targetId, { scopeRevision: next.revision, catalogVersion: catalog.value!.version })
    await reload('Revision ' + next.revision + ' saved and recalculated. Previous approvals do not transfer.')
  })
}
async function requestReview() {
  if (!scope.value || !catalog.value) return
  await run(async () => {
    await api.submitReview(currentId.value, { scopeRevision: scope.value!.revision, catalogVersion: catalog.value!.version })
    await reload('Submitted for independent human review.')
  })
}
async function approveReview() {
  if (!scope.value || !catalog.value) return
  await run(async () => {
    await api.approve(currentId.value, { scopeRevision: scope.value!.revision, catalogVersion: catalog.value!.version })
    await reload('Review approved by the current verified reviewer or fixture reviewer.')
  })
}
async function previewApproved() {
  if (!scope.value || !approved.value) return
  clearFeedback()
  proposalBusy.value = true
  try {
    const result = await api.export(currentId.value, scope.value.revision)
    if (result.revision !== scope.value.revision || result.projectId !== currentId.value)
      throw new ApiError(409, 'REVISION_MISMATCH', 'Export returned an unexpected project or revision.')
    proposal.value = result
    await loadTimeline()
  } catch (cause) { proposal.value = null; showError(cause) }
  finally { proposalBusy.value = false }
}
function download(kind: 'md' | 'json') {
  if (!proposal.value || !approved.value || proposal.value.revision !== scope.value?.revision) return
  const name = 'scopehatch-' + proposal.value.projectId.replace(/[^a-zA-Z0-9-]/g, '-') +
    '-r' + proposal.value.revision + '.' + kind
  const body = kind === 'json' ? JSON.stringify(proposal.value, null, 2) : proposal.value.markdown
  const url = URL.createObjectURL(new Blob([body], { type: kind === 'json' ? 'application/json' : 'text/markdown' }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  document.body.append(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}
function eventDate(event: AuditEvent) {
  const raw = event.timestamp ?? event.createdAt
  if (!raw) return 'Time unavailable'
  const date = new Date(raw)
  return Number.isNaN(date.valueOf()) ? 'Time unavailable' : date.toLocaleString()
}
async function beginLogin() {
  try { await beginSignIn() } catch(cause) { showError(cause) }
}
async function changeWorkspace() {
  if (isDemo || !authenticated.value || !guardUnsaved()) return
  ownerDenied.value = false
  sessionStorage.setItem('scopehatch.workspace', selectedWorkspace.value.trim())
  snapshot.value = null
  currentId.value = ''
  catalogs.value = []
  await run(async () => { await loadWorkspace() })
}
async function disconnect() {
  signOut()
  authenticated.value = false
  snapshot.value = null
  catalogs.value = []
  currentId.value = ''
  clearFeedback()
  projectPage.value = null
  ownerDenied.value = false
  catalogDirty.value = false
  draftDirty.value = false
  view.value = 'index'
}

function parseLines(value: string) { return value.split('\n').map(x => x.trim()).filter(Boolean) }
function validateProposal(value: ProposalMetadata, deliverables: Deliverable[]) {
  const groups = [value.assumptions,value.exclusions,value.commercialTerms]
  if (value.overview.length > 4000 || groups.some(a => a.length > 50 || a.some(x => x.length > 2000)) ||
      deliverables.some(x => (x.clientDescription ?? '').length > 2000) || JSON.stringify(value).length > 65536)
    throw new ApiError(422,'INVALID_INPUT','Proposal text exceeds the contract limits. Use shorter descriptions and up to 50 entries per section.')
}
function guardUnsaved() {
  return !(draftDirty.value || catalogDirty.value) ||
    window.confirm('Discard unsaved scope or catalog changes? They have not been saved as a revision.')
}
function navigate(next: 'index' | 'workbench' | 'new' | 'catalog') {
  if (!guardUnsaved()) return
  clearFeedback()
  view.value = next
  if (next === 'index') void loadIndex()
}
function hydrateCatalog() {
  const latest = catalog.value
  catalogBaseVersion.value = latest?.version ?? 0
  catalogCurrency.value = latest?.currency ?? 'IDR'
  rateRows.value = (latest?.services ?? []).map(x => ({
    key:++rowKey,id:x.id,label:x.label,price:String(x.unitPriceMinor)
  }))
  catalogDirty.value = false
}
function markCatalogDirty() { catalogDirty.value = true; notice.value = '' }
async function refreshCatalogs() {
  if (!guardUnsaved()) return
  clearFeedback()
  catalogSaving.value = true
  try {
    catalogs.value = await api.catalogs()
    hydrateCatalog()
    notice.value = 'Loaded the latest published catalog version.'
  } catch (cause) { showError(cause) }
  finally { catalogSaving.value = false }
}
function addRate() {
  rateRows.value.push({key:++rowKey,id:'',label:'',price:'0'})
  markCatalogDirty()
}
async function saveCatalog() {
  if (!canManageCatalog.value) return
  clearFeedback()
  const services = rateRows.value.map(x => ({id:x.id.trim(),label:x.label.trim(),unitPriceMinor:Number(x.price)}))
  if (!services.length || services.length > 200 || new Set(services.map(x=>x.id)).size !== services.length ||
      rateRows.value.some(x=>!x.price.trim() || !/^\d+$/.test(x.price.trim())) ||
      services.some(x=>!x.id || !x.label || !Number.isSafeInteger(x.unitPriceMinor) || x.unitPriceMinor < 0) || !/^[A-Z]{3}$/.test(catalogCurrency.value)) {
    error.value = 'Add 1–200 unique named services with nonnegative safe integer prices in minor units.'
    return
  }
  catalogSaving.value = true
  try {
    await api.createCatalog({baseVersion:catalogBaseVersion.value,currency:catalogCurrency.value,services})
    catalogs.value = await api.catalogs()
    hydrateCatalog()
    if (currentId.value && snapshot.value) await reload()
    await loadIndex()
    notice.value = 'New immutable catalog version published. Existing estimates must be recalculated and reviewed.'
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 403) ownerDenied.value = true
    if (cause instanceof ApiError && cause.code === 'STALE_CATALOG_VERSION')
      error.value = 'Another owner published rates. Your edits remain unsaved; reload latest before retrying.'
    else showError(cause)
  } finally { catalogSaving.value = false }
}
async function loadIndex(cursor: string | null = null, page = 0) {
  if (!authenticated.value) return
  listBusy.value = true
  try {
    const result = await api.listProjects({limit:10,cursor:cursor ?? undefined})
    projectPage.value = result
    pageNumber.value = page
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 401) authenticated.value = false
    showError(cause)
  } finally { listBusy.value = false }
}
async function nextPage() {
  if (!projectPage.value?.nextCursor) return
  const next = projectPage.value.nextCursor
  await loadIndex(next,pageNumber.value+1)
  if (!error.value) pageCursors.value[pageNumber.value] = next
}
async function previousPage() {
  if (pageNumber.value === 0) return
  await loadIndex(pageCursors.value[pageNumber.value-1],pageNumber.value-1)
}
async function loadWorkspace() {
  catalogs.value = await api.catalogs()
  hydrateCatalog()
  pageCursors.value = [null]
  pageNumber.value = 0
  await loadIndex()
}
async function openExisting(id: string) {
  if (!guardUnsaved()) return
  await loadProject(id)
}
function confirmUnload(event: BeforeUnloadEvent) {
  if (!draftDirty.value && !catalogDirty.value) return
  event.preventDefault()
}
window.addEventListener('beforeunload', confirmUnload)
onUnmounted(() => window.removeEventListener('beforeunload', confirmUnload))

onMounted(async () => {
  try {
    if (!isDemo) {
      await finishSignIn()
      authenticated.value = isSignedIn()
      if (!authenticated.value) { loading.value = false; return }
    }
    await loadWorkspace()
    if (isDemo) await loadProject(fixtureProjectId)
    else loading.value = false
  } catch (cause) { showError(cause); loading.value = false }
})
</script>

<template>
  <a class="skip-link" href="#main-content">Skip to workbench</a>
  <div class="app-shell">
    <aside class="sidebar" aria-label="Primary navigation">
      <div class="brand"><div class="brand-mark" aria-hidden="true">S<span>·</span></div><div><strong>Scopehatch</strong><small>Operator workbench</small></div></div>
      <div class="sidebar-section">
        <p class="eyebrow">WORKSPACE</p>
        <button class="nav-link" :class="{ selected: view === 'index' }" type="button" :disabled="busy || !authenticated" @click="navigate('index')"><span aria-hidden="true">▦</span> Projects</button>
        <button class="nav-link" :class="{ selected: hasProject }" type="button" :disabled="busy || !snapshot" @click="navigate('workbench')"><span aria-hidden="true">▤</span> Current project</button>
        <button class="nav-link" :class="{ selected: view === 'new' }" type="button" :disabled="busy || !authenticated" @click="navigate('new')"><span aria-hidden="true">＋</span> New brief</button>
        <button class="nav-link" :class="{ selected: view === 'catalog' }" type="button" :disabled="busy || !authenticated" @click="navigate('catalog')"><span aria-hidden="true">◫</span> Rate catalog</button>
      </div>
      <div class="sidebar-section compact">
        <p class="eyebrow">RECENT PROJECTS</p>
        <p v-if="!projectPage?.items.length" class="side-help">No projects loaded in this workspace.</p>
        <button v-for="item in projectPage?.items.slice(0,4) ?? []" :key="item.id" type="button"
          class="nav-link recent-project" :disabled="busy || loading" @click="openExisting(item.id)">
          <span class="recent-title">{{ item.title }}</span><small>{{ item.status }}</small>
        </button>
      </div>
      <div class="sidebar-section compact project-id-fallback">
        <details open>
          <summary>Open by project ID</summary>
          <form class="project-jump-form" @submit.prevent="openExisting(projectIdInput.trim())">
            <label for="project-id">Project ID</label>
            <div class="project-jump">
              <input id="project-id" v-model="projectIdInput" autocomplete="off" placeholder="Project ID" required />
              <button type="submit" aria-label="Open project by ID" :disabled="loading || busy">→</button>
            </div>
          </form>
        </details>
      </div>
      <div class="sidebar-bottom">
        <div class="mode-flag" :class="{ 'live-flag': !isDemo }"><span class="flag-dot"></span>{{ isDemo ? 'DEMO FIXTURE · LOCAL ONLY' : 'API MODE · AUTH REQUIRED' }}</div>
        <div v-if="isDemo" class="identity">
          <p class="eyebrow">TEST PERSONA</p>
          <label for="persona">Acting as</label>
          <select id="persona" :value="persona" :disabled="busy" @change="changePersona(($event.target as HTMLSelectElement).value as FixturePersona)">
            <option value="operator">Morgan · Operator (fixture)</option>
            <option value="reviewer">Alex · Reviewer (fixture)</option>
            <option value="owner">Taylor · Owner (fixture)</option>
          </select>
          <p class="side-help">Simulated roles, not signed-in users. The API never receives these identities.</p>
        </div>
        <p class="side-foot">Every proposal needs human judgment.</p>
      </div>
    </aside>

    <div class="main-column">
      <header class="topbar">
        <div class="breadcrumbs"><span>Workspace</span><span aria-hidden="true">/</span><strong>{{ view === 'new' ? 'New intake' : view === 'index' ? 'Projects' : view === 'catalog' ? 'Catalog versions' : snapshot?.project.title ?? 'Project' }}</strong></div>
        <span class="top-meta">Brief → Scope → Review → Proposal</span>
      </header>

      <main id="main-content" tabindex="-1">
        <div v-if="isDemo" class="demo-ribbon" role="note">
          <strong>Sample workspace.</strong> All people, briefs, rates and approvals here are synthetic. Data resets on refresh; nothing is sent.
        </div>
        <div v-else class="api-ribbon" role="note">
          <strong>Authenticated API mode.</strong>
          <span v-if="authenticated"> Signed in with an external OIDC provider. Permissions are verified by the server.</span>
          <span v-else-if="oidcReady"> Sign in through your configured identity provider to access a workspace.</span>
          <span v-else> Configure VITE_OIDC_CLIENT_ID, VITE_OIDC_AUTHORIZATION_ENDPOINT and VITE_OIDC_TOKEN_ENDPOINT to enable live mode.</span>
          <button v-if="!authenticated && oidcReady" class="button secondary" type="button" @click="beginLogin">Sign in securely</button>
          <label v-if="authenticated" for="workspace-select">Workspace ID</label>
          <input v-if="authenticated" id="workspace-select" v-model="selectedWorkspace" autocomplete="off" placeholder="Authorized workspace ID" />
          <button v-if="authenticated" class="button secondary" type="button" @click="changeWorkspace">Select workspace</button>
          <button v-if="authenticated" class="button secondary" type="button" @click="disconnect">Sign out</button>
        </div>
        <div v-if="error" class="alert error-alert" role="alert">
          <span aria-hidden="true">!</span><div><strong>Couldn't complete that action</strong><p>{{ error }}</p></div>
          <button type="button" aria-label="Dismiss error" @click="error = ''">×</button>
        </div>
        <div v-if="notice" class="alert notice-alert" role="status"><span aria-hidden="true">✓</span><p>{{ notice }}</p><button type="button" aria-label="Dismiss message" @click="notice = ''">×</button></div>

        <section v-if="view === 'index'" class="index-page" aria-labelledby="index-heading">
          <div v-if="!catalog" class="inline-alert" role="status">This workspace has no published catalog yet. <button class="text-button" type="button" @click="navigate('catalog')">Open owner catalog setup →</button></div>
          <div class="index-header">
            <div><p class="overline">WORKSPACE / PROJECTS</p><h1 id="index-heading">Your studio's work.</h1><p class="lede">Reopen original briefs and see each project's current status.</p></div>
            <button class="button primary" type="button" :disabled="!authenticated" @click="navigate('new')">New client brief →</button>
          </div>
          <p v-if="listBusy" role="status" class="blank-state">Loading projects…</p>
          <div v-else-if="projectPage?.items.length" class="project-cards">
            <button v-for="item in projectPage.items" :key="item.id" type="button" class="project-card" @click="openExisting(item.id)">
              <span class="project-card-top"><strong>{{ item.title }}</strong><span class="index-status" :class="item.status">{{ item.status === 'draft' ? 'Needs estimate' : item.status === 'blocked' ? 'Blocked' : item.status === 'ready' ? 'Ready' : item.status === 'pending' ? 'Pending review' : 'Approved' }}</span></span>
              <span class="project-card-meta">Created {{ new Date(item.createdAt).toLocaleDateString() }} · Open project →</span>
            </button>
          </div>
          <div v-else class="empty-workspace"><h2>No projects in this workspace yet.</h2><p>Create one from an original brief. No IDs to copy or remember.</p><button class="button primary" type="button" :disabled="!authenticated" @click="navigate('new')">Create first project</button></div>
          <nav class="pagination" aria-label="Project pages">
            <button class="button secondary" type="button" :disabled="listBusy || pageNumber === 0" @click="previousPage">← Previous page</button><span>Page {{ pageNumber + 1 }}</span>
            <button class="button secondary" type="button" :disabled="listBusy || !projectPage?.nextCursor" @click="nextPage">Next page →</button>
          </nav>
        </section>
        <section v-else-if="view === 'catalog'" class="catalog-page" aria-labelledby="catalog-heading">
          <p class="overline">STUDIO PRICING / OWNER CONTROLLED</p><h1 id="catalog-heading">Versioned rate catalog.</h1>
          <p class="lede">Publishing replaces the entire service list as a new immutable version. Prices are integer minor units, never model-generated.</p>
          <div class="surface-card">
            <div class="panel-heading"><div><h2>Catalog v{{ catalog?.version ?? 0 }}</h2><p class="muted">{{ catalogs.length }} recorded version{{ catalogs.length === 1 ? '' : 's' }}</p></div>
              <button class="button secondary" type="button" :disabled="catalogSaving" @click="refreshCatalogs">Reload published rates</button>
            </div>
            <p v-if="!catalog" class="inline-alert">No catalog exists yet. A verified owner must publish version one before a quote can be priced.</p>
            <p v-if="ownerDenied" role="status" class="inline-alert">The API denied catalog publishing (403). Verified owner membership is required.</p>
            <p v-if="isDemo && !canManageCatalog" class="inline-alert">Switch to Taylor · Owner (fixture) to test catalog publishing.</p>
            <p v-else-if="!isDemo && canManageCatalog" class="muted">The server checks owner membership on publish; this editor is not proof of authorization.</p>
            <form v-if="canManageCatalog" class="catalog-form" @submit.prevent="saveCatalog">
              <div class="field"><label for="catalog-currency">ISO currency</label><input id="catalog-currency" v-model="catalogCurrency" maxlength="3" required @input="markCatalogDirty" /></div>
              <div v-for="(rate,index) in rateRows" :key="rate.key" class="rate-editor">
                <strong>Service {{ index+1 }}</strong>
                <div class="field"><label :for="'rate-id-'+rate.key">Service ID</label><input :id="'rate-id-'+rate.key" v-model="rate.id" required @input="markCatalogDirty" /></div>
                <div class="field"><label :for="'rate-label-'+rate.key">Service label</label><input :id="'rate-label-'+rate.key" v-model="rate.label" required @input="markCatalogDirty" /></div>
                <div class="field"><label :for="'rate-price-'+rate.key">Unit price (minor units)</label><input :id="'rate-price-'+rate.key" v-model="rate.price" inputmode="numeric" pattern="[0-9]+" required @input="markCatalogDirty" /></div>
                <button class="text-button danger" type="button" @click="rateRows = rateRows.filter(x => x.key !== rate.key); markCatalogDirty()">Remove</button>
              </div>
              <button class="button secondary" type="button" :disabled="rateRows.length >= 200" @click="addRate">＋ Add catalog service</button>
              <p v-if="catalogDirty" class="dirty-note">Unsaved pricing changes. Previous versions cannot be edited.</p>
              <button class="button primary" type="submit" :disabled="catalogSaving || !catalogDirty">{{ catalogSaving ? 'Publishing…' : 'Publish new catalog version →' }}</button>
            </form>
            <details v-if="catalogs.length" class="catalog-history"><summary>View published version history</summary>
              <div v-for="version in catalogs" :key="version.version" class="catalog-history-row"><strong>Version {{ version.version }} · {{ version.currency }}</strong><p>{{ version.services.length }} services · read-only</p></div>
            </details>
          </div>
        </section>
        <section v-else-if="view === 'new'" class="intake-page" aria-labelledby="intake-heading">
          <p class="overline">01 / INTAKE</p>
          <h1 id="intake-heading">Begin with the client's words.</h1>
          <p class="lede">The original brief is preserved as evidence. You decide what the actual work includes.</p>
          <form class="intake-card" @submit.prevent="newProject">
            <label for="new-title">Project title <span class="required">*</span></label>
            <input id="new-title" v-model="creatingTitle" required maxlength="140" placeholder="e.g. Northpoint / exterior imagery" />
            <label for="new-brief">Original client brief <span class="required">*</span></label>
            <textarea id="new-brief" v-model="creatingBrief" required rows="12" placeholder="Paste the unedited request here. Include quantities, deadlines and supplied references if mentioned." />
            <div class="form-footer"><p>Scope and prices are added in the next step. No inference required.</p><button class="button primary" type="submit" :disabled="busy">{{ busy ? 'Creating…' : 'Create project →' }}</button></div>
          </form>
        </section>

        <div v-else-if="loading" class="loading-view" role="status"><div class="spinner"></div><p>Loading the project and its revision history…</p></div>
        <section v-else-if="!snapshot" class="empty-workspace">
          <p class="overline">START HERE</p><h1>Every clear proposal starts with a messy brief.</h1>
          <p>Create a project to record the request before estimating any work. Or browse the workspace project list.</p>
          <button type="button" class="button primary" @click="navigate('new')">New client brief →</button>
        </section>
        <template v-else>
          <div class="workspace-intro">
            <div><p class="overline">PROJECT / {{ snapshot.project.id }}</p><h1>{{ snapshot.project.title }}</h1><p class="lede">Source-backed scope · Catalog v{{ catalog?.version ?? '—' }} · {{ catalog?.currency ?? 'No catalog' }}</p></div>
            <div class="status-pill" :class="status.tone"><span class="status-dot" aria-hidden="true"></span>{{ status.label }}</div>
          </div>
          <ol class="steps" aria-label="Proposal process">
            <li class="done"><span>01</span> Intake</li>
            <li :class="{ done: Boolean(scope) }"><span>02</span> Scope & estimate</li>
            <li :class="{ done: Boolean(pending || approved) }"><span>03</span> Review</li>
            <li :class="{ done: Boolean(approved) }"><span>04</span> Proposal</li>
          </ol>
          <section v-if="!isDemo && authenticated" class="surface-card" aria-labelledby="suggestion-heading">
            <div class="panel-heading"><div><p class="overline">OPTIONAL / GOVERNED INFERENCE</p><h2 id="suggestion-heading">Brief suggestions</h2></div><span class="mini-tag">Not an approval</span></div>
            <p class="muted">Suggestions require the tenant's allowed model and reserved budget. Evidence is verified against the original brief. The model cannot set catalog prices or approve a proposal.</p>
            <button class="button secondary" type="button" :disabled="busy || suggestionBusy || draftDirty || !currentId" @click="requestSuggestions">
              {{ suggestionBusy ? 'Checking model policy…' : 'Suggest from original brief' }}
            </button>
            <p v-if="draftDirty" class="dirty-note">Save or discard unsaved changes before requesting a fresh suggestion.</p>
            <div v-if="suggestion" class="blocker-list">
              <h3>Advisory output · {{ suggestion.model }} · usage {{ suggestion.usage.status }}</h3>
              <ul>
                <li v-for="(item,index) in suggestion.suggestion.suggestedDeliverables" :key="index">
                  <strong>{{ serviceName(item.serviceId) }} × {{ item.quantity ?? '?' }}</strong>
                  <span>{{ item.evidence?.quote ?? 'No exact brief evidence — manual confirmation required' }}</span>
                </li>
              </ul>
              <p v-if="suggestion.suggestion.unknowns.length">Unresolved: {{ suggestion.suggestion.unknowns.join('; ') }}</p>
              <p>Usage status is not a statement of price. Unknown metering retains its reservation until reconciliation.</p>
              <button class="button secondary" type="button" :disabled="busy || draftDirty" @click="applySuggestionsToDraft">Copy suggestions into editable draft →</button>
            </div>
          </section>
          <div class="work-grid">
            <section class="source-panel" aria-labelledby="source-heading">
              <div class="panel-heading"><div><p class="overline">SOURCE / IMMUTABLE</p><h2 id="source-heading">Client brief</h2></div><span class="mini-tag">Original</span></div>
              <p class="source-guidance">Read alongside the scoped items. Choose words from the brief as evidence, or explicitly mark your own assumptions.</p>
              <blockquote class="brief-text">{{ focusSegments.before }}<mark v-if="focusSegments.match">{{ focusSegments.match }}</mark>{{ focusSegments.after }}</blockquote>
              <p v-if="activeEvidence && !focusSegments.match" class="evidence-warning">The selected evidence is not an exact phrase in this brief. Use “Manual note” for an assumption.</p>
              <div class="source-foot"><span aria-hidden="true">◈</span><p>The original text is never rewritten when scope revisions change.</p></div>
            </section>

            <section class="scope-panel" aria-labelledby="scope-heading">
              <div class="panel-heading"><div><p class="overline">SCOPE / REVISION {{ scope?.revision ?? 'NOT SAVED' }}</p><h2 id="scope-heading">What are we delivering?</h2></div><span class="mini-tag">Editable draft</span></div>
              <p class="muted">Use the studio's catalog. Quantities left blank are unknown, not zero. Saving creates a new immutable revision.</p>
              <div v-if="!catalog" class="inline-alert">No service catalog is available. Pricing cannot proceed.</div>
              <div v-if="lines.length === 0" class="empty-lines"><strong>No deliverables yet.</strong><p>Add a service from the catalog to start defining the work.</p></div>
              <div v-for="(line, index) in lines" :key="line.key" class="scope-line">
                <div class="line-title"><strong>Deliverable {{ String(index + 1).padStart(2, '0') }}</strong><button type="button" class="text-button danger" :disabled="busy || !canEdit" :aria-label="'Remove deliverable ' + (index + 1)" @click="removeLine(line.key)">Remove</button></div>
                <div class="line-fields">
                  <div class="field wide"><label :for="'service-' + line.key">Catalog service</label>
                    <select :id="'service-' + line.key" v-model="line.serviceId" :disabled="busy || !canEdit" @change="edit">
                      <option v-for="service in catalog?.services ?? []" :key="service.id" :value="service.id">{{ service.label }}</option>
                    </select>
                  </div>
                  <div class="field qty"><label :for="'quantity-' + line.key">Quantity</label>
                    <input :id="'quantity-' + line.key" v-model="line.quantity" type="number" min="1" step="1" inputmode="numeric" placeholder="?" :disabled="busy || !canEdit" @input="edit" />
                  </div>
                </div>
                <p class="rate">Catalog rate: {{ servicePrice(line.serviceId) }} / unit</p>
                <div class="field"><label :for="'source-' + line.key">Evidence type</label>
                  <select :id="'source-' + line.key" v-model="line.source" :disabled="busy || !canEdit" @change="edit">
                    <option value="brief">Quoted from brief</option><option value="manual">Manual note / assumption</option>
                  </select>
                </div>
                <div class="field"><label :for="'evidence-' + line.key">{{ line.source === 'brief' ? 'Exact brief excerpt' : 'Reason for manual entry' }}</label>
                  <input :id="'evidence-' + line.key" v-model="line.evidence" :disabled="busy || !canEdit" :placeholder="line.source === 'brief' ? 'Copy the client’s exact words' : 'Explain the assumption or correction'" @focus="activeEvidence = line.source === 'brief' ? line.evidence : ''" @input="edit(); activeEvidence = line.source === 'brief' ? line.evidence : ''" />
                </div>
                <div class="field"><label :for="'description-' + line.key">Client-facing description</label>
                  <textarea :id="'description-' + line.key" v-model="line.clientDescription" maxlength="2000" rows="2" :disabled="busy || !canEdit" placeholder="Describe this deliverable for the client" @input="edit" />
                </div>
              </div>
              <button type="button" class="button secondary add-line" :disabled="busy || !canEdit || !catalog" @click="addLine">＋ Add deliverable</button>
              <div class="unknown-section"><div class="subheading"><h3>Open questions & assumptions</h3><span class="mini-tag">Each line blocks pricing</span></div>
                <label for="unknowns">One unresolved requirement per line. Remove only after it has been clarified.</label>
                <textarea id="unknowns" v-model="unknowns" rows="3" :disabled="busy || !canEdit" placeholder="e.g. Number of exterior angles must be confirmed" @input="edit" />
              </div>
              <fieldset class="proposal-fields" :disabled="busy || !canEdit">
                <legend>Client-facing proposal content</legend>
                <p class="muted">Human-authored content belongs to this immutable scope revision. Text-only changes require fresh estimate and approval.</p>
                <div class="field"><label for="proposal-overview">Overview</label><textarea id="proposal-overview" v-model="metadata.overview" maxlength="4000" rows="3" @input="edit" /></div>
                <div class="field"><label for="proposal-assumptions">Assumptions (one per line)</label><textarea id="proposal-assumptions" v-model="assumptionsText" rows="3" @input="edit" /></div>
                <div class="field"><label for="proposal-exclusions">Exclusions (one per line)</label><textarea id="proposal-exclusions" v-model="exclusionsText" rows="3" @input="edit" /></div>
                <div class="field"><label for="proposal-terms">Commercial terms (one per line)</label><textarea id="proposal-terms" v-model="commercialTermsText" rows="3" @input="edit" /></div>
                <details class="proposed-preview"><summary>Preview editable proposal text</summary>
                  <p>{{ metadata.overview || 'No overview entered.' }}</p>
                  <h4>Assumptions</h4><p v-for="(item,index) in parseLines(assumptionsText)" :key="'a'+index">{{ item }}</p>
                  <h4>Exclusions</h4><p v-for="(item,index) in parseLines(exclusionsText)" :key="'e'+index">{{ item }}</p>
                  <h4>Commercial terms</h4><p v-for="(item,index) in parseLines(commercialTermsText)" :key="'t'+index">{{ item }}</p>
                </details>
              </fieldset>
              <div class="scope-actions">
                <p v-if="draftDirty" class="dirty-note">● Unsaved changes — any approval would not apply to them.</p>
                <button class="button primary" type="button" :disabled="busy || !canEdit || !catalog || localInvalid || (!draftDirty && Boolean(scope))" @click="saveScope">
                  {{ busy ? 'Working…' : scope ? 'Save new revision & estimate →' : 'Save first scope & estimate →' }}
                </button>
                <p v-if="localInvalid" class="field-error" role="status">Fix invalid quantities and use an exact excerpt for every brief-sourced line.</p>
              </div>
            </section>
          </div>

          <div class="lower-grid">
            <section class="surface-card" aria-labelledby="estimate-heading">
              <div class="panel-heading"><div><p class="overline">PRICING / DETERMINISTIC</p><h2 id="estimate-heading">Estimate & blockers</h2></div><span class="mini-tag">Catalog v{{ catalog?.version ?? '—' }}</span></div>
              <p v-if="draftDirty" class="inline-alert">The estimate below does not include your unsaved edits. Save a new revision to recalculate.</p>
              <div v-if="!estimate" class="blank-state">No estimate for the current saved revision. Save scope to calculate catalog pricing.</div>
              <template v-else>
                <div class="estimate-row" v-for="(line, index) in estimate.lines" :key="index">
                  <span>{{ serviceName(line.serviceId) }} <small>× {{ line.quantity ?? '?' }}</small></span><strong>{{ money(line.subtotalMinor, estimate.currency) }}</strong>
                </div>
                <div class="total-row"><span>Total ({{ estimate.currency }})</span><strong>{{ money(estimate.totalMinor, estimate.currency) }}</strong></div>
                <div v-if="estimate.blockers.length" class="blocker-list"><h3><span aria-hidden="true">⚑</span> {{ estimate.blockers.length }} pricing blocker{{ estimate.blockers.length === 1 ? '' : 's' }}</h3>
                  <ul><li v-for="(item, index) in estimate.blockers" :key="index"><strong>{{ item.code.replaceAll('_', ' ').toLowerCase() }}</strong><span>{{ item.detail }}</span></li></ul>
                </div>
                <p v-else class="ready-note">✓ All price inputs are available. This is still a draft until another person approves the exact revision.</p>
              </template>
            </section>

            <section class="surface-card" aria-labelledby="review-heading">
              <div class="panel-heading"><div><p class="overline">GATE / SEPARATION OF DUTIES</p><h2 id="review-heading">Human review</h2></div><span class="mini-tag">Revision-bound</span></div>
              <p class="muted">Approval binds the scope revision, catalog version and estimate. Saving a new scope never inherits an old approval.</p>
              <div class="review-state" :class="{ 'approved-state': approved }">
                <strong>{{ superseded ? 'Previous review superseded' : approved ? 'Approved for export' : pending ? 'Awaiting independent approval' : blocked ? 'Review unavailable' : 'No active review' }}</strong>
                <p v-if="superseded">The existing review refers to revision {{ review?.scopeRevision }}, not the latest revision {{ scope?.revision }}.</p>
                <p v-else-if="approved">Approved by {{ review?.approvedBy }} for scope r{{ review?.scopeRevision }} and catalog v{{ review?.catalogVersion }}.</p>
                <p v-else-if="pending">Submitted by {{ review?.submittedBy }}. Another authorized reviewer must approve or it stays pending.</p>
                <p v-else-if="blocked">Resolve every pricing blocker first, then save and recalculate.</p>
                <p v-else>Once the estimate is ready, send this revision to a different reviewer.</p>
              </div>
              <button v-if="isDemo ? canEdit : authenticated" type="button" class="button primary full" :disabled="busy || draftDirty || !scope || estimate?.state !== 'ready' || (reviewCurrent && !!review)" @click="requestReview">
                {{ pending ? 'Awaiting reviewer' : approved ? 'Already approved' : 'Request review →' }}
              </button>
              <button v-if="isDemo ? !canEdit : authenticated" type="button" class="button primary full" :disabled="busy || !pending || draftDirty || estimate?.state !== 'ready'" @click="approveReview">
                {{ pending ? 'Approve exact revision →' : 'Nothing awaiting your approval' }}
              </button>
              <p class="review-foot">In API mode permissions are checked by the server, not by these button states.</p>
            </section>
          </div>

          <section class="proposal-card" aria-labelledby="proposal-heading">
            <div class="panel-heading"><div><p class="overline">OUTPUT / REVIEWED ARTIFACT</p><h2 id="proposal-heading">Proposal draft</h2></div><span class="mini-tag">No sending</span></div>
            <div class="proposal-toolbar">
              <div><strong>{{ approved ? 'Approved revision ' + scope?.revision : 'Export is locked' }}</strong><p>{{ approved ? 'Inspect the exact approved artifact before downloading it.' : 'Only an approved, current revision can be previewed or exported.' }}</p></div>
              <button type="button" class="button primary" :disabled="!approved || busy || proposalBusy" @click="previewApproved">{{ proposalBusy ? 'Loading…' : 'Preview approved draft →' }}</button>
            </div>
            <div v-if="proposal && approved" class="proposal-preview">
              <div class="preview-header"><span>READ-ONLY · r{{ proposal.revision }}</span><div><button class="text-button" type="button" @click="download('md')">Download .md ↓</button><button class="text-button" type="button" @click="download('json')">Download .json ↓</button></div></div>
              <pre>{{ proposal.markdown }}</pre>
            </div>
          </section>

          <section class="audit-card" aria-labelledby="audit-heading">
            <button class="audit-toggle" type="button" :aria-expanded="showTimeline" aria-controls="audit-body" @click="showTimeline = !showTimeline">
              <span><span class="overline">TRACEABILITY</span><strong id="audit-heading">Audit timeline</strong><small>{{ events.length }} loaded event{{ events.length === 1 ? '' : 's' }}</small></span><span aria-hidden="true">{{ showTimeline ? '−' : '+' }}</span>
            </button>
            <div v-if="showTimeline" id="audit-body" class="audit-body">
              <p v-if="!events.length" class="blank-state">No audit events were returned for this project.</p>
              <ol v-else class="event-list"><li v-for="(event, index) in events" :key="event.id ?? index"><div class="event-dot"></div><div><strong>{{ event.action ?? 'Event' }}</strong><p>{{ eventDate(event) }} · {{ event.actorId ?? 'Actor unavailable' }}<span v-if="event.scopeRevision"> · Scope r{{ event.scopeRevision }}</span></p></div></li></ol>
              <button v-if="cursor" class="button secondary" type="button" @click="loadTimeline(true)">Load older events</button>
            </div>
          </section>
        </template>
      </main>
      <footer class="footer">SCOPEHATCH <span>·</span> Evidence before certainty. Approval before export.</footer>
    </div>
  </div>
</template>
