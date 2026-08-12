-- Single-use "set your own password" links: the initial invite for a new
-- account, and later password resets. One table for both because they are
-- the same operation — prove control of the mailbox, then choose a password.
--
-- Only the SHA-256 of the token is stored; the raw value lives solely in
-- the emailed link, so a database read cannot be turned into account
-- takeover on every pending invite.
-- CreateTable
CREATE TABLE "UserSetupToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "purpose" TEXT NOT NULL DEFAULT 'INVITE',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserSetupToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserSetupToken_tokenHash_key" ON "UserSetupToken"("tokenHash");

-- CreateIndex
CREATE INDEX "UserSetupToken_userId_idx" ON "UserSetupToken"("userId");

-- CreateIndex
CREATE INDEX "UserSetupToken_expiresAt_idx" ON "UserSetupToken"("expiresAt");

-- AddForeignKey
ALTER TABLE "UserSetupToken" ADD CONSTRAINT "UserSetupToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
