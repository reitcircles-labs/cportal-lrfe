# Document storage: market research and recommendations

*Research for the next epic: a document store that is robust, compliant with enterprise security,
and meets or exceeds the storage practice of market EDRMS products. Written 3 October 2026.*

This is desk research (vendor documentation, standards, technical articles), not hands-on testing.
Vendor certification claims are as published. Ceph's and SeaweedFS's Object Lock behaviour should be
verified in a proof of concept before a decision.

## 1. What the portal does today

| Area | Today | Gap against EDRMS practice |
|---|---|---|
| **Where files live** | `@lrfe/storage` (`packages/storage`): a local folder (development), AWS S3 (`EDRMS_STORAGE=s3`, `AWS_BUCKET_REGION`) or memory | The production option is AWS, so documents are stored outside Namibia, not locally hosted. The local folder has no redundancy. |
| **No overwriting** | Each version gets its own key (`<prefix>/<id>/v<n>/<file>`); the local store refuses to overwrite a file (`wx`) | Only enforced by our code. Anyone with storage access can still delete or replace files, and the service has a delete call (used to clean up a failed filing). |
| **Integrity** | SHA-256 per file; a seal over the file hash plus the version's metadata (`services/edrms/src/seal.js`); **Check integrity** in Documents | The seal is a plain hash, not a signature: someone with database access could rewrite a value and recompute it. No trusted timestamp, no scheduled integrity sweep. |
| **Encryption** | AWS-managed encryption (S3 `AES256`); none for the local folder | No encryption under our control, no key management, no key rotation |
| **Retention** | Metadata only (ISO 23081 record metadata) | The storage does not enforce retention periods, legal holds or destruction |
| **Copies and recovery** | None of our own | No replication, no offline copy, no restore tests |

## 2. How market EDRMS products store files on-premises

All major products share one pattern: **records metadata in a database, files in a separate content
store**, often made **unchangeable (WORM)** for records.

| Product | Content store | Unchangeable records | Encryption |
|---|---|---|---|
| **OpenText Content Server + Archive Center** | Storage chosen by archiving rules | NetApp SnapLock, Dell ECS; retention and destruction driven by Records Management | |
| **OpenText Content Manager (ex-HP TRIM)** | "Document stores" on file shares | Via the storage underneath | AES-256 per document store |
| **IBM FileNet** | Storage areas, or "fixed content devices" | WORM devices; a disposition sweep keeps storage retention in step with records retention | External keys via KMIP |
| **Alfresco (Hyland)** | File system, encrypted store, S3 connector, content store selector | WORM through the S3 connector and Governance Services | AES-256 encrypted content store |
| **M-Files** | Vault file data | | AES-256, FIPS 140-2 |
| **Storage platforms underneath** | Hitachi HCP, NetApp StorageGRID, Dell ECS/ObjectScale, Cloudian HyperStore | Retention set at write time. StorageGRID's S3 Object Lock is independently assessed (Cohasset) against SEC 17a-4(f). | Built in |

### Standards

- **ISO 15489**: records management (retention, storage and handling, access, disposal).
- **ISO 16175**: functional requirements for records in business systems.
- **MoReq2010**: modular, detailed records-system requirements.
- **DoD 5015.2**: US design criteria for records management software.
- **ISO 14721 (OAIS)**: long-term preservation and readability.
- **ISO 23081**: records metadata (already used by the portal).

### Namibia

The National Archives of Namibia oversees public-sector records management under the Archives Act
(No. 12 of 1992): it approves file plans, retention guidelines and transfers. Studies note that the Act
does not yet address electronic records specifically. Building to the international standards above is
the safe way to meet the National Archives' approval.

## 3. Self-hosted storage options

| Option | Unchangeable records (S3 Object Lock) | Fit |
|---|---|---|
| **Ceph (object gateway, RGW)** | Yes: compliance and governance modes, legal hold; must be enabled when a bucket is created | Open source, proven at scale, replicates across sites, erasure coding. Needs 3 or more servers and staff who know Ceph. **Best open-source choice for a government registry.** |
| **SeaweedFS** | Yes: compliance and governance modes, legal hold | Open source, much lighter to run. Younger, not independently assessed. Good for development, test and smaller sites. |
| **NetApp StorageGRID / Hitachi HCP / Dell ECS-ObjectScale / Cloudian HyperStore** | Yes (StorageGRID's is Cohasset-assessed) | Commercial appliances with vendor support and certifications. Best if budget allows and support contracts are wanted. |
| **NetApp ONTAP SnapLock** | File-based WORM, certified (SEC 17a-4, FINRA and others) | If the registry already has NetApp file storage |
| ~~MinIO Community~~ | | **Avoid:** maintenance mode since December 2025, repository archived April 2026; no more fixes or official builds |
| ~~Garage~~ | **No** Object Lock | Not suitable for records |

## 4. Recommendations

1. **Metadata in PostgreSQL; files in self-hosted, S3-compatible object storage with Object Lock,
   inside Namibia.**
   - Ceph if the registry runs it themselves, or StorageGRID/HCP as an appliance.
   - Two sites with replication, plus an offline copy.
   - `@lrfe/storage` already speaks S3, so the code change is small: our own endpoint instead of AWS.
2. **Make sealed versions unchangeable in the storage itself.**
   - Compliance-mode Object Lock; the retain-until date comes from the retention schedule; legal hold
     where needed.
   - The EDRMS service's storage account has no delete permission.
   - Intake's temporary scans go in a separate bucket without lock, deleted automatically after filing
     or rejection.
3. **Encrypt in our own service before storing.**
   - AES-256-GCM with a key per file (envelope encryption).
   - Keys held in **OpenBao** (the open-source fork of Vault), backed by a hardware security module if
     available (PKCS#11 support since OpenBao 2.7). Keys rotated; the storage never sees plain files.
4. **Make integrity provable, not only checkable.**
   - **Sign** each seal with a key held in OpenBao, so a database administrator cannot forge one.
   - **Timestamp** a daily summary hash (Merkle root) of all new seals with an RFC 3161 timestamp
     authority (RFC 4998 evidence records): proof of when each record existed.
   - A **scheduled integrity sweep** that re-reads files and checks hashes and signatures, with alerts.
5. **Retention and destruction.**
   - Destruction only after the retention date, approved by two people, with a destruction certificate
     kept as a record.
   - File plans and retention schedules as approved by the National Archives.
6. **Long-term readability (OAIS).** Store a PDF/A copy next to the original when filing; check formats
   on intake.
7. **Operations.**
   - TLS between all services and the storage; least-privilege storage accounts.
   - Storage access logs feeding the audit trail.
   - Database backups with point-in-time recovery; restore drills with agreed recovery targets
     (RPO/RTO).

**The decision that drives the rest:** Ceph run in-house, or a commercial appliance.

## Sources

- [MinIO removes management features from Community Edition (Blocks & Files)](https://blocksandfiles.com/2025/06/19/minio-removes-management-features-from-basic-community-edition-object-storage-code/)
- [MinIO maintenance mode (GitHub issue #21714)](https://github.com/minio/minio/issues/21714)
- [MinIO's community edition is archived: what still runs in 2026](https://stormdevelopments.ca/blog/minio-s-community-edition-is-archived-what-still-runs-in-2026/)
- [Replacing MinIO: Ceph vs SeaweedFS vs Garage](https://stribog.com/blog/minio-exit-rook-ceph-seaweedfs-garage-sovereign-object-storage)
- [SeaweedFS vs Garage vs Ceph 2026](https://akmatori.com/blog/minio-alternatives-2026-comparison)
- [SeaweedFS: S3 Object Lock and Retention (wiki)](https://github-wiki-see.page/m/seaweedfs/seaweedfs/wiki/S3-Object-Lock-and-Retention)
- [Garage S3 compatibility status](https://garagehq.deuxfleurs.fr/documentation/reference-manual/s3-compatibility/)
- [How to configure S3 Object Lock (WORM) in Ceph RGW](https://oneuptime.com/blog/post/2026-03-31-rook-s3-object-lock-worm-ceph-rgw/view)
- [AWS S3 Object Lock documentation](https://docs.aws.amazon.com/AmazonS3/latest/dev/object-lock.html)
- [OpenText Archiving for Content Server (PDF)](https://www.opentext.com/file_source/OpenText/en_US/PDF/OpenText-Archiving-for-Content-Server.pdf)
- [Upgrading OpenText Archive Server 10.5 to Archive Center 16.2](https://ecodocx.com/blog/upgrading-from-opentext-archive-server-10-5-to-archive-center-16-2/)
- [NetApp SnapLock](https://www.netapp.com/ontap-data-management-software/snaplock/)
- [NetApp: archive and compliance using SnapLock (PDF)](https://docs.netapp.com/us-en/ontap/pdfs/sidebar/Archive_and_compliance_using_SnapLock_technology.pdf)
- [StorageGRID: test and demonstrate S3 Object Lock](https://docs.netapp.com/us-en/storagegrid-enable/examples/test-demonstrate-S3-object-lock.html)
- [StorageGRID data security](https://docs.netapp.com/us-en/storagegrid-enable/technical-reports/data-security)
- [Alfresco adds WORM storage for regulatory compliance](https://idm.net.au/node/13143)
- [Alfresco S3 connector configuration](https://docs.alfresco.com/aws-s3/4.0/config/)
- [IBM FileNet: configuring fixed content device disposition sweep](https://www.ibm.com/support/knowledgecenter/SSNVVQ_5.2.1/com.ibm.p8.ier.admin.doc/ierag190.html)
- [IBM Encryption Foundation for FileNet Content Manager (PDF)](https://public.dhe.ibm.com/software/pdf/dk/service-shop/ibm-encryption-foundation-for-filenet-content-manager.pdf)
- [OpenText Content Manager Enterprise Studio](https://www.microfocus.com/documentation/content-manager/24.4/QuickRef/Content/ContentMng_TES.htm)
- [M-Files file data encryption FAQ](https://empower.m-files.com/article/File-data-encryption-FAQ)
- [Hitachi Content Platform retention and compliance](https://credly.com/org/hitachi-vantara/badge/hitachi-content-platform-retention-and-compliance)
- [Cloudian: S3 Object Lock for ransomware protection and compliance](https://cloudian.com/blog/s3-object-lock-protecting-data-for-ransomware-threats-and-compliance.md)
- [OpenBao 2.7.0 release notes](https://openbao.org/community/release-notes/2-7-0/)
- [Best open-source alternatives to HashiCorp Vault 2026](https://ossalt.com/guides/best-open-source-alternatives-to-hashicorp-vault-2026)
- [RFC 4998: Evidence Record Syntax](https://datatracker.ietf.org/doc/rfc4998/)
- [Timestamp authority server: must-have features (Ascertia)](https://blog.ascertia.com/timestamp-authority-server-the-must-have-features)
- [National Records of Scotland: standards for electronic records management](https://nrscotland.gov.uk/record-keeping/electronic-records-management/standards-and-requirements-for-electronic-records-management)
- [How MoReq relates to ISO 15489](https://www.moreq.info/faq/20-how-is-moreq-related-to-iso-15489)
- [National Archives of Namibia: records management](https://nan.gov.na/records-management)
- [A study of electronic records management in the Namibian Public Service (UNAM)](https://repository.unam.edu.na/items/04690306-9fac-4c00-b330-09895941450b)
