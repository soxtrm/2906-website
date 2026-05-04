'use client'

import { useState, useEffect, useCallback } from 'react'
import { Calendar, momentLocalizer, Views } from 'react-big-calendar'
import withDragAndDrop from 'react-big-calendar/lib/addons/dragAndDrop'
import moment from 'moment'
import 'react-big-calendar/lib/css/react-big-calendar.css'
import 'react-big-calendar/lib/addons/dragAndDrop/styles.css'
import { Search, X, Trash2, MapPin, Map, MessageSquare, Phone, Plus } from 'lucide-react'

const localizer = momentLocalizer(moment)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const DnDCalendar = withDragAndDrop(Calendar as any)

const API_BASE = ''

interface Agent {
  id: number
  username: string
  display_name: string
  color_hex: string
  whatsapp_phone: string
}

interface CalEvent {
  id: number
  agent_id: number
  client_id: string | null
  client_name: string | null
  client_nationality: string | null
  client_phone: string | null
  event_type: string
  title: string | null
  scheduled_at: string
  duration_minutes: number
  address: string | null
  maps_link: string | null
  comment: string | null
  agent_color: string | null
  start: Date
  end: Date
}

interface Client {
  id: string
  name: string
  nationalities: string[] | null
  phone: string | null
}

interface EditState {
  id: number
  agent_id: number
  client_id: string | null
  event_type: string
  title: string
  scheduled_at: string
  duration_minutes: number
  address: string
  maps_link: string
  comment: string
}

function countryFlag(code: string | null) {
  if (!code || code.length !== 2) return ''
  try {
    return code.toUpperCase().split('').map(c => String.fromCodePoint(c.codePointAt(0)! + 0x1F1A5)).join('')
  } catch { return '' }
}

export default function CalendarInternaPage() {
  const [agents, setAgents] = useState<Agent[]>([])
  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null)
  const [events, setEvents] = useState<CalEvent[]>([])
  const [clients, setClients] = useState<Client[]>([])
  const [search, setSearch] = useState('')
  const [editingEvent, setEditingEvent] = useState<EditState | null>(null)
  const [draggingClient, setDraggingClient] = useState<Client | null>(null)
  const [weekOffset, setWeekOffset] = useState(0)
  const [currentDate, setCurrentDate] = useState(new Date())

  useEffect(() => {
    fetch(`${API_BASE}/api/agents`)
      .then(r => r.json())
      .then((data: Agent[]) => {
        setAgents(data)
        setSelectedAgent(data.find(a => a.username === 'kev') || data[0] || null)
      })
      .catch(console.error)
  }, [])

  const loadEvents = useCallback(() => {
    if (!selectedAgent) return
    const from = moment(currentDate).startOf('week').toISOString()
    const to = moment(currentDate).endOf('week').toISOString()
    fetch(`${API_BASE}/api/calendar?agent_id=${selectedAgent.id}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
      .then(r => r.json())
      .then((data: Omit<CalEvent, 'start' | 'end'>[]) => {
        setEvents(data.map(ev => ({
          ...ev,
          start: new Date(ev.scheduled_at),
          end: new Date(new Date(ev.scheduled_at).getTime() + ev.duration_minutes * 60000)
        })))
      })
      .catch(console.error)
  }, [selectedAgent, currentDate])

  useEffect(() => { loadEvents() }, [loadEvents])

  useEffect(() => {
    const url = `${API_BASE}/api/clients?active=true${search ? `&search=${encodeURIComponent(search)}` : ''}`
    fetch(url)
      .then(r => r.json())
      .then((data: Client[]) => setClients(Array.isArray(data) ? data : []))
      .catch(console.error)
  }, [search])

  useEffect(() => {
    setCurrentDate(moment().add(weekOffset, 'weeks').toDate())
  }, [weekOffset])

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleEventDrop = async ({ event, start, end }: any) => {
    const ev = event as CalEvent
    await fetch(`${API_BASE}/api/calendar/${ev.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scheduled_at: (start as Date).toISOString(),
        duration_minutes: Math.round(((end as Date).getTime() - (start as Date).getTime()) / 60000)
      })
    })
    setEvents(prev => prev.map(e =>
      e.id === ev.id ? { ...e, start: start as Date, end: end as Date, scheduled_at: (start as Date).toISOString() } : e
    ))
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleDropFromOutside = async ({ start }: any) => {
    if (!draggingClient || !selectedAgent) return
    const startDate = start as Date
    const endDate = new Date(startDate.getTime() + 30 * 60000)
    const result = await fetch(`${API_BASE}/api/calendar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_id: selectedAgent.id,
        client_id: draggingClient.id,
        event_type: 'viewing',
        title: `Viewing - ${draggingClient.name}`,
        scheduled_at: startDate.toISOString(),
        duration_minutes: 30
      })
    }).then(r => r.json())
    setEvents(prev => [...prev, {
      ...result,
      client_name: draggingClient.name,
      client_nationality: draggingClient.nationality,
      client_phone: draggingClient.contact_phone,
      agent_color: selectedAgent.color_hex,
      start: startDate,
      end: endDate
    }])
    setDraggingClient(null)
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleSelectSlot = ({ start, end }: any) => {
    if (!selectedAgent) return
    setEditingEvent({
      id: 0,
      agent_id: selectedAgent.id,
      client_id: null,
      event_type: 'viewing',
      title: '',
      scheduled_at: (start as Date).toISOString(),
      duration_minutes: Math.max(30, Math.round(((end as Date).getTime() - (start as Date).getTime()) / 60000)),
      address: '',
      maps_link: '',
      comment: ''
    })
  }

  const handleSelectEvent = (event: object) => {
    const ev = event as CalEvent
    setEditingEvent({
      id: ev.id,
      agent_id: ev.agent_id,
      client_id: ev.client_id,
      event_type: ev.event_type,
      title: ev.title || '',
      scheduled_at: ev.scheduled_at,
      duration_minutes: ev.duration_minutes,
      address: ev.address || '',
      maps_link: ev.maps_link || '',
      comment: ev.comment || ''
    })
  }

  const saveEvent = async () => {
    if (!editingEvent) return
    const method = editingEvent.id === 0 ? 'POST' : 'PATCH'
    const url = editingEvent.id === 0
      ? `${API_BASE}/api/calendar`
      : `${API_BASE}/api/calendar/${editingEvent.id}`
    const result = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(editingEvent)
    }).then(r => r.json())
    const start = new Date(result.scheduled_at)
    const end = new Date(start.getTime() + result.duration_minutes * 60000)
    const enriched: CalEvent = { ...result, start, end, agent_color: selectedAgent?.color_hex || null }
    if (editingEvent.id === 0) {
      setEvents(prev => [...prev, enriched])
    } else {
      setEvents(prev => prev.map(e => e.id === editingEvent.id ? enriched : e))
    }
    setEditingEvent(null)
  }

  const deleteEvent = async () => {
    if (!editingEvent || editingEvent.id === 0) return
    if (!confirm('Delete this event?')) return
    await fetch(`${API_BASE}/api/calendar/${editingEvent.id}`, { method: 'DELETE' })
    setEvents(prev => prev.filter(e => e.id !== editingEvent.id))
    setEditingEvent(null)
  }

  const eventStyleGetter = () => ({
    style: {
      backgroundColor: selectedAgent?.color_hex || '#D4AF37',
      borderRadius: '6px',
      border: 'none',
      color: '#fff',
      padding: '2px 6px',
      fontWeight: 500,
      fontSize: '12px'
    }
  })

  const weekLabels = ['This Week', 'Next Week', 'Week +2']

  return (
    <div className="min-h-screen bg-stone-50">
      <div className="max-w-7xl mx-auto p-4 pb-32">

        {/* Header */}
        <div className="flex items-center justify-between mb-6 pt-4">
          <h1 className="text-2xl font-light text-stone-800">
            {selectedAgent ? `${selectedAgent.display_name}'s Calendar` : 'Calendar'}
          </h1>
          <div className="flex items-center gap-3">
            <span className="text-xs text-stone-400">Internal · 2906 Real Estate</span>
            <button
              onClick={() => {
                if (!selectedAgent) return
                const now = new Date()
                now.setMinutes(Math.ceil(now.getMinutes() / 30) * 30, 0, 0)
                setEditingEvent({
                  id: 0, agent_id: selectedAgent.id, client_id: null,
                  event_type: 'viewing', title: '', scheduled_at: now.toISOString(),
                  duration_minutes: 30, address: '', maps_link: '', comment: ''
                })
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-white rounded-lg hover:opacity-90"
              style={{ backgroundColor: selectedAgent?.color_hex || '#D4AF37' }}
              data-testid="new-event-btn"
            >
              <Plus className="w-4 h-4" /> New Event
            </button>
          </div>
        </div>

        {/* Week switcher */}
        <div className="flex gap-2 mb-4">
          {weekLabels.map((label, offset) => {
            const start = moment().add(offset, 'weeks').startOf('week')
            const end = moment().add(offset, 'weeks').endOf('week')
            return (
              <button
                key={offset}
                onClick={() => setWeekOffset(offset)}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
                  weekOffset === offset
                    ? 'text-white shadow-sm'
                    : 'bg-white text-stone-600 border border-stone-200 hover:border-stone-400'
                }`}
                style={weekOffset === offset ? { backgroundColor: selectedAgent?.color_hex || '#D4AF37' } : {}}
              >
                <span className="font-semibold">{label}</span>
                <span className="ml-1 text-xs opacity-75">
                  {start.format('D MMM')} – {end.format('D MMM')}
                </span>
              </button>
            )
          })}
        </div>

        {/* Calendar */}
        <div
          className="bg-white rounded-2xl shadow-sm border border-stone-100 overflow-hidden mb-6"
          style={{ height: 600 }}
          onDragOver={e => e.preventDefault()}
          onDrop={e => {
            if (!draggingClient) return
            e.preventDefault()
          }}
        >
          <DnDCalendar
            localizer={localizer}
            events={events}
            date={currentDate}
            onNavigate={setCurrentDate}
            defaultView={Views.WEEK}
            view={Views.WEEK}
            onView={() => {}}
            step={30}
            timeslots={2}
            onEventDrop={handleEventDrop}
            onEventResize={handleEventDrop}
            onDropFromOutside={handleDropFromOutside}
            dragFromOutsideItem={draggingClient ? (() => ({ title: draggingClient.name })) : undefined}
            onSelectSlot={handleSelectSlot}
            onSelectEvent={handleSelectEvent}
            selectable
            resizable
            eventPropGetter={eventStyleGetter}
            titleAccessor={(ev) => {
              const e = ev as CalEvent
              const flag = countryFlag(e.client_nationality)
              return `${flag} ${e.client_name || e.title || e.event_type}`.trim()
            }}
            style={{ height: '100%' }}
          />
        </div>

        {/* Client list */}
        <div className="bg-white rounded-2xl shadow-sm border border-stone-100 p-4">
          <div className="flex items-center gap-3 mb-4">
            <h2 className="text-lg font-light text-stone-700">Clients</h2>
            <div className="relative flex-1 max-w-xs">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-400" />
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search clients..."
                className="w-full pl-9 pr-3 py-1.5 text-sm border border-stone-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-stone-400"
              />
              {search && (
                <button onClick={() => setSearch('')} className="absolute right-3 top-1/2 -translate-y-1/2">
                  <X className="w-3.5 h-3.5 text-stone-400" />
                </button>
              )}
            </div>
            <span className="text-xs text-stone-400">{clients.length} clients · drag to calendar</span>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2 max-h-64 overflow-y-auto">
            {clients.map(client => (
              <div
                key={client.id}
                draggable
                onDragStart={() => setDraggingClient(client)}
                onDragEnd={() => setDraggingClient(null)}
                className={`p-2.5 rounded-lg border cursor-grab active:cursor-grabbing select-none transition-all ${
                  draggingClient?.id === client.id
                    ? 'border-stone-400 bg-stone-50 opacity-60'
                    : 'border-stone-200 bg-stone-50 hover:border-stone-400 hover:bg-white'
                }`}
              >
                <div className="font-medium text-sm text-stone-800 truncate">
                  {countryFlag(client.nationalities?.[0] || null)} {client.name}
                </div>
                {client.phone && (
                  <div className="text-xs text-stone-500 mt-0.5 flex items-center gap-1">
                    <Phone className="w-3 h-3" />{client.phone}
                  </div>
                )}
              </div>
            ))}
            {clients.length === 0 && (
              <div className="col-span-4 text-center text-stone-400 py-6 text-sm">No clients found</div>
            )}
          </div>
        </div>
      </div>

      {/* Agent tab switcher - fixed bottom */}
      <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-stone-200 px-4 py-2 z-50">
        <div className="max-w-7xl mx-auto flex gap-1 overflow-x-auto">
          {agents.map(agent => (
            <button
              key={agent.id}
              onClick={() => setSelectedAgent(agent)}
              className={`flex-shrink-0 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                selectedAgent?.id === agent.id ? 'text-white shadow-sm' : 'text-stone-600 hover:bg-stone-100'
              }`}
              style={selectedAgent?.id === agent.id ? { backgroundColor: agent.color_hex } : {}}
            >
              {agent.display_name}
            </button>
          ))}
        </div>
      </div>

      {/* Event edit modal */}
      {editingEvent && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md">
            <div className="flex items-center justify-between p-4 border-b border-stone-100">
              <h3 className="font-medium text-stone-800">
                {editingEvent.id === 0 ? 'New Event' : 'Edit Event'}
              </h3>
              <button onClick={() => setEditingEvent(null)} className="text-stone-400 hover:text-stone-600">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-4 space-y-3">
              <div>
                <label className="text-xs text-stone-500 uppercase tracking-wide">Title</label>
                <input
                  value={editingEvent.title}
                  onChange={e => setEditingEvent({ ...editingEvent, title: e.target.value })}
                  placeholder="Viewing, Meeting..."
                  className="w-full mt-1 px-3 py-2 border border-stone-200 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-stone-400"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-stone-500 uppercase tracking-wide">Date & Time</label>
                  <input
                    type="datetime-local"
                    value={moment(editingEvent.scheduled_at).format('YYYY-MM-DDTHH:mm')}
                    onChange={e => setEditingEvent({ ...editingEvent, scheduled_at: new Date(e.target.value).toISOString() })}
                    className="w-full mt-1 px-3 py-2 border border-stone-200 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-stone-400"
                  />
                </div>
                <div>
                  <label className="text-xs text-stone-500 uppercase tracking-wide">Duration (min)</label>
                  <input
                    type="number"
                    value={editingEvent.duration_minutes}
                    onChange={e => setEditingEvent({ ...editingEvent, duration_minutes: parseInt(e.target.value) || 30 })}
                    min={15}
                    step={15}
                    className="w-full mt-1 px-3 py-2 border border-stone-200 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-stone-400"
                  />
                </div>
              </div>

              <div>
                <label className="text-xs text-stone-500 uppercase tracking-wide flex items-center gap-1">
                  <MapPin className="w-3 h-3" /> Address
                </label>
                <input
                  value={editingEvent.address}
                  onChange={e => setEditingEvent({ ...editingEvent, address: e.target.value })}
                  placeholder="Property address"
                  className="w-full mt-1 px-3 py-2 border border-stone-200 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-stone-400"
                />
              </div>

              <div>
                <label className="text-xs text-stone-500 uppercase tracking-wide flex items-center gap-1">
                  <Map className="w-3 h-3" /> Maps Link
                </label>
                <input
                  value={editingEvent.maps_link}
                  onChange={e => setEditingEvent({ ...editingEvent, maps_link: e.target.value })}
                  placeholder="https://maps.google.com/..."
                  className="w-full mt-1 px-3 py-2 border border-stone-200 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-stone-400"
                />
              </div>

              <div>
                <label className="text-xs text-stone-500 uppercase tracking-wide flex items-center gap-1">
                  <MessageSquare className="w-3 h-3" /> Comment
                </label>
                <textarea
                  value={editingEvent.comment}
                  onChange={e => setEditingEvent({ ...editingEvent, comment: e.target.value })}
                  placeholder="Notes, instructions..."
                  rows={2}
                  className="w-full mt-1 px-3 py-2 border border-stone-200 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-stone-400 resize-none"
                />
              </div>
            </div>

            <div className="flex justify-between items-center p-4 border-t border-stone-100">
              <div>
                {editingEvent.id !== 0 && (
                  <button onClick={deleteEvent} className="flex items-center gap-1.5 text-red-500 hover:text-red-700 text-sm">
                    <Trash2 className="w-4 h-4" /> Delete
                  </button>
                )}
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => setEditingEvent(null)}
                  className="px-4 py-2 text-sm text-stone-600 border border-stone-200 rounded-lg hover:bg-stone-50"
                >
                  Cancel
                </button>
                <button
                  onClick={saveEvent}
                  className="flex items-center gap-1.5 px-4 py-2 text-sm text-white rounded-lg hover:opacity-90"
                  style={{ backgroundColor: selectedAgent?.color_hex || '#D4AF37' }}
                >
                  <Plus className="w-4 h-4" />
                  {editingEvent.id === 0 ? 'Create' : 'Save'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
