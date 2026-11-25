import OrganizationManager from '@/components/admin/OrganizationManager';
import OrgApiKeysPanel from '@/components/admin/OrgApiKeysPanel';
import DormantLockPanel from '@/components/admin/DormantLockPanel';
import OrgSsoPanel from '@/components/admin/OrgSsoPanel';
import LibrarySharesPanel from '@/components/admin/LibrarySharesPanel';

export default function AdminOrganizationPage() {
  return (
    <>
      <OrganizationManager />
      <DormantLockPanel />
      <OrgSsoPanel />
      <LibrarySharesPanel />
      <OrgApiKeysPanel />
    </>
  );
}
