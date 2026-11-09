import OrganizationManager from '@/components/admin/OrganizationManager';
import OrgApiKeysPanel from '@/components/admin/OrgApiKeysPanel';

export default function AdminOrganizationPage() {
  return (
    <>
      <OrganizationManager />
      <OrgApiKeysPanel />
    </>
  );
}
