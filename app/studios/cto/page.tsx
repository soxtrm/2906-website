// nexusstudios.one/cto -> the admin-only CTO Cockpit in the CRM (one login, the existing staff authentication)
import { redirect } from 'next/navigation'
export default function CtoRedirect() { redirect('https://crm.2906.estate/crm/cto') }
