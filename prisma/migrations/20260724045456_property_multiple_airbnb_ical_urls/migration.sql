/*
  Warnings:

  - You are about to drop the column `airbnbIcalImportUrl` on the `Property` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Property" DROP COLUMN "airbnbIcalImportUrl",
ADD COLUMN     "airbnbIcalImportUrls" TEXT[] DEFAULT ARRAY[]::TEXT[];
