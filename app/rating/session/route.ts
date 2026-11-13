// Same HTTP-only cookie and canonical identity flow as ARGUS; no second auth system.
// Namespaced so the Nexus domain can proxy only the private presentation routes.
export { POST } from '../../api/crm/login/route'
