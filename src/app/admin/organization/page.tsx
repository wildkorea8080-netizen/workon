import OrganizationManager from '@/components/admin/OrganizationManager';
import OrgApiKeysPanel from '@/components/admin/OrgApiKeysPanel';
import DormantLockPanel from '@/components/admin/DormantLockPanel';
import OrgSsoPanel from '@/components/admin/OrgSsoPanel';

export default function AdminOrganizationPage() {
  return (
    <>
      <OrganizationManager />
      <DormantLockPanel />
      <OrgSsoPanel />
      <OrgApiKeysPanel />
    </>
  );
}
