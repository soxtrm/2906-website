import { brainAccess } from '@/lib/nexus-brain/access'
import BrainExperience from '@/components/nexus-brain/experience'
import AccessGate from '@/components/nexus-brain/access-gate'

export const dynamic = 'force-dynamic'
export default async function RatingPage() {
  const access = await brainAccess()
  // Authenticate before rendering any presentation HTML or RSC content.
  return access === 'allowed' ? <BrainExperience /> : <AccessGate state={access} />
}
