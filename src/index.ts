import { MongoClient, Db, Collection } from "mongodb";
import { execSync } from "child_process";
import { format } from "date-fns";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";

// Configuración con tipos
interface Config {
  MONGO_URI: string;
  CHECK_INTERVAL: number;
  BACKUP_DIR: string;
  SALES_COLLECTION: string;
  BACKUPS_COLLECTION: string;
}

const CONFIG: Config = {
  MONGO_URI: "mongodb://localhost:27017/tocgame",
  CHECK_INTERVAL: 300000, // 5 minutos
  BACKUP_DIR: "/var/backups/tocgamedb",
  SALES_COLLECTION: "sales",
  BACKUPS_COLLECTION: "backups",
};

// Tipos para los documentos de MongoDB
interface Sale {
  _id: string;
  createdAt: Date;
  // ... otros campos según tu estructura
}

interface BackupRecord {
  path: string;
  createdAt: Date;
  type: "emergency" | "scheduled";
  status: "created" | "failed" | "restored";
}

class DisasterRecoveryManager {
  private dbClient?: MongoClient;

  constructor(private config: Config) {
    this.ensureBackupDir();
  }

  private ensureBackupDir(): void {
    if (!existsSync(this.config.BACKUP_DIR)) {
      mkdirSync(this.config.BACKUP_DIR, { recursive: true });
    }
  }

  public async checkRecentSales(): Promise<boolean> {
    this.dbClient = new MongoClient(this.config.MONGO_URI);

    try {
      await this.dbClient.connect();
      const database: Db = this.dbClient.db();
      const collection: Collection<Sale> = database.collection(
        this.config.SALES_COLLECTION
      );

      const fiveMinutesAgo = new Date(Date.now() - this.config.CHECK_INTERVAL);

      const count: number = await collection.countDocuments({
        createdAt: { $gte: fiveMinutesAgo },
      });

      return count > 0;
    } finally {
      await this.dbClient.close();
    }
  }

  public showDialog(): boolean {
    try {
      execSync(
        "zenity --question " +
          '--title="Verificación de sistema" ' +
          '--text="No se detectaron ventas en los últimos 5 minutos. ¿Está teniendo problemas con el sistema?" ' +
          "--width=300",
        { stdio: "inherit" }
      );
      return true;
    } catch (error) {
      return false;
    }
  }

  public async createBackup(): Promise<void> {
    const timestamp = format(new Date(), "yyyyMMdd-HHmmss");
    const backupName = `backup-${timestamp}`;
    const backupPath = join(this.config.BACKUP_DIR, backupName);

    // Crear dump de MongoDB dentro del contenedor
    try {
      // 1. Ejecutar mongodump dentro del contenedor
      execSync(
        `docker exec mongo mongodump --uri="${this.config.MONGO_URI}" --out="/tmp/${backupName}"`,
        { stdio: "inherit" }
      );

      // 2. Copiar el backup al host
      execSync(`docker cp mongo:/tmp/${backupName} ${backupPath}`, {
        stdio: "inherit",
      });

      // 3. Limpiar el backup temporal del contenedor
      execSync(`docker exec mongo rm -rf /tmp/${backupName}`, {
        stdio: "inherit",
      });
    } catch (error) {
      console.error("Error creating MongoDB dump:", error);
      throw error;
    }

    // Registrar backup en la base de datos
    const client = new MongoClient(this.config.MONGO_URI);

    try {
      await client.connect();
      const database: Db = client.db();
      const collection: Collection<BackupRecord> = database.collection(
        this.config.BACKUPS_COLLECTION
      );

      await collection.insertOne({
        path: backupPath,
        createdAt: new Date(),
        type: "emergency",
        status: "created",
      });
    } finally {
      await client.close();
    }
  }

  public async startMonitoring(): Promise<void> {
    while (true) {
      try {
        const hasRecentSales = await this.checkRecentSales();

        if (!hasRecentSales) {
          const needsHelp = this.showDialog();

          if (needsHelp) {
            await this.createBackup();
            console.log("Backup de emergencia creado");
            // Lógica adicional para cambiar al backup
          }
        }
      } catch (error) {
        console.error("Monitoring error:", error);
      }

      await new Promise((resolve) =>
        setTimeout(resolve, this.config.CHECK_INTERVAL)
      );
    }
  }
}

// Ejecución del programa
const manager = new DisasterRecoveryManager(CONFIG);
manager.startMonitoring().catch(console.error);
