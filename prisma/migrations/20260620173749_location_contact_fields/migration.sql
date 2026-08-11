-- AlterTable
ALTER TABLE "Location" ADD COLUMN     "email" TEXT,
ADD COLUMN     "isVirtual" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "notes" TEXT,
ADD COLUMN     "phone" TEXT,
ADD COLUMN     "virtualLink" TEXT;
