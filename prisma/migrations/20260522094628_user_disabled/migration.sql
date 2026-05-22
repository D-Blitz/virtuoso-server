-- AlterTable
ALTER TABLE "Role" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- RenameIndex
ALTER INDEX "UserPermissionScope_userId_permission_resourceType_resourceId_k" RENAME TO "UserPermissionScope_userId_permission_resourceType_resource_key";
