import { QueryTypes } from "sequelize";
import * as _ from "lodash";
import sequelize from "../../database";
import { GetCompanySetting } from "../../helpers/CheckSettings";
import User from "../../models/User";

export interface DashboardData {
  counters: any;
  attendants: [];
}

export interface Params {
  days?: number;
  currentUser?: number;
  date_from?: string;
  date_to?: string;
}

export default async function DashboardDataService(
  companyId: string | number,
  params: Params
): Promise<DashboardData> {
  
  const user = await User.findByPk(params.currentUser, {
    include: [{ association: "queues" }],
  });
  const isAdminUser = user?.profile === "admin";

  const ticketsUserFilter = isAdminUser ? "" : `AND t."userId" = ?`;
  const queueIds = user && Array.isArray(user.queues) ? user.queues.map(q => q.id) : [];
  const pendingUserFilter = isAdminUser || queueIds.length === 0
    ? ""
    : `AND t."queueId" IN (${queueIds.map(() => "?").join(",")})`;

  const groupsTab =
    (await GetCompanySetting(Number(companyId), "groupsTab", "disabled")) ===
    "enabled";

  const groupsDisabled =
    (await GetCompanySetting(
      Number(companyId),
      "CheckMsgIsGroup",
      "enabled"
    )) === "enabled";

  const groupsWhere = groupsDisabled || groupsTab ? 'AND NOT t."isGroup"' : "";

  const query = `
    with
    traking as (
      select
        c.name "companyName",
        u.name "userName",
        (select count(*) > 0 as online from "UserSocketSessions" tu where tu."userId" = t."userId" and tu."active" is True) "userOnline",
        w.name "whatsappName",
        ct.name "contactName",
        ct.number "contactNumber",
        (tt."finishedAt" is not null) "finished",
        (tt."userId" is null and tt."finishedAt" is null) "pending",
        (tt."startedAt" is not null and tt."finishedAt" is null) "open",
        coalesce((
          (date_part('day', age(coalesce(tt."ratingAt", tt."finishedAt") , tt."startedAt")) * 24 * 60) +
          (date_part('hour', age(coalesce(tt."ratingAt", tt."finishedAt"), tt."startedAt")) * 60) +
          (date_part('minutes', age(coalesce(tt."ratingAt", tt."finishedAt"), tt."startedAt")))
        ), 0) "supportTime",
        coalesce((
          (date_part('day', age(tt."startedAt", tt."queuedAt")) * 24 * 60) +
          (date_part('hour', age(tt."startedAt", tt."queuedAt")) * 60) +
          (date_part('minutes', age(tt."startedAt", tt."queuedAt")))
        ), 0) "waitTime",
        t.status,
        tt.*,
        t."userId" as "ticketUserId",
        ct."id" "contactId"
      from "TicketTraking" tt
      left join "Companies" c on c.id = tt."companyId"
      left join "Tickets" t on t.id = tt."ticketId"
      left join "Users" u on u.id = t."userId"
      left join "Whatsapps" w on w.id = tt."whatsappId"
      left join "Contacts" ct on ct.id = t."contactId"
      where tt."companyId" = ?
      ${isAdminUser ? "" : `AND (t."userId" = ? OR (t."userId" IS NULL AND tt."userId" = ?))`}
      -- filterPeriod
    ),
    counters as (
      select
        (select avg("supportTime") from traking where "supportTime" > 0) "avgSupportTime",
        (select avg("waitTime") from traking where "waitTime" > 0) "avgWaitTime",
        (
          select count(distinct t."id")
          from "Tickets" t
          where t.status like 'open' and t."companyId" = ? ${ticketsUserFilter}
        ) "supportHappening",
        (
          select count(distinct t."id")
          from "Tickets" t
          left join "TicketTraking" tt on t.id = tt."ticketId"
          left join "UserQueues" uq on t."queueId" = uq."queueId"
          where t.status = 'pending'
          and t."companyId" = ?
          and tt."finishedAt" is null
          ${isAdminUser ? "" : `AND t."queueId" IS NOT NULL`} -- Exclui tickets sem fila para não admins
          ${pendingUserFilter}
          ${groupsWhere}
        ) "supportPending",
        (
          select count(id) from traking where finished
        ) "supportFinished",
        (
          select count(leads.id) from (
            select
              ct1.id,
              count(tt1.id) total
            from traking tt1
            left join "Tickets" t1 on t1.id = tt1."ticketId"
            left join "Contacts" ct1 on ct1.id = t1."contactId"
            group by 1
            having count(tt1.id) = 1
          ) leads
        ) "leads"
    ),
    attedants as (
      select
        u.id,
        u.name,
        coalesce(att."avgSupportTime", 0) "avgSupportTime",
        coalesce(att."avgWaitTime", 0) "avgWaitTime",
        att.tickets,
        att.rating,
        (select count(*) > 0 as online from "UserSocketSessions" us where us."userId" = u.id and us."active" is True) online,
        att."closeCount",
        att."openCount"
      from "Users" u
      left join (
        select
          u1.id,
          u1."name",
          (select count(*) > 0 as online from "UserSocketSessions" us1 where us1."userId" = u1.id and us1."active" is True) "online",
          avg(t."supportTime") "avgSupportTime",
          avg(t."waitTime") "avgWaitTime",
          count(t."id") tickets,
          coalesce(avg(ur.rate), 0) rating,
          (
            select count(distinct "id")
            from traking
            where "finishedAt" is not null
            and "ticketUserId" = u1.id
          ) AS "closeCount",
          (
            select count(distinct "id")
            from traking
            where "startedAt" is not null 
            and "finishedAt" is null
            and "ticketUserId" = u1.id
          ) AS "openCount"
        from "Users" u1
        left join traking t on t."ticketUserId" = u1.id
        left join "UserRatings" ur on ur."userId" = t."ticketUserId" and ur."createdAt"::date = t."finishedAt"::date
        where ${isAdminUser ? "u1.\"companyId\" = ?" : `u1.id = ?`}
        group by 1, 2
      ) att on att.id = u.id
      where ${isAdminUser ? "u.\"companyId\" = ?" : `u.id = ?`}
      order by att.name
    )
    select
      (select coalesce(jsonb_build_object('counters', c.*)->>'counters', '{}')::jsonb from counters c) counters,
      (select coalesce(json_agg(a.*), '[]')::jsonb from attedants a) attendants;
  `;

  const replacements: any[] = [];

  // 1. tt."companyId" = ? (traking)
  replacements.push(companyId);

  // 2. t."userId" = ? e tt."userId" = ? (traking, se não for admin)
  if (!isAdminUser && user) {
    replacements.push(params.currentUser); // Para t."userId" = ?
    replacements.push(params.currentUser); // Para tt."userId" = ?
  }

  // 3. Filtros de data (tt."createdAt" >= ? e tt."createdAt" <= ?)
  let whereFilter = "";
  if (_.has(params, "days")) {
    whereFilter += " and tt.\"createdAt\" >= (now() - '? days'::interval)";
    replacements.push(parseInt(`${params.days}`.replace(/\D/g, ""), 10));
  }

  if (_.has(params, "date_from")) {
    whereFilter += " and tt.\"createdAt\" >= ?";
    replacements.push(`${params.date_from} 00:00:00`);
  }

  if (_.has(params, "date_to")) {
    whereFilter += " and tt.\"createdAt\" <= ?";
    replacements.push(`${params.date_to} 23:59:59`);
  }

  // 4. Para supportHappening: t."companyId" = ? e t."userId" = ? (se não for admin)
  replacements.push(companyId); // Para t."companyId" = ?
  if (!isAdminUser && user) {
    replacements.push(params.currentUser); // Para t."userId" = ? em supportHappening
  }

  // 5. Para supportPending: t."companyId" = ? e t."queueId" IN (?,?,...) (se não for admin)
  replacements.push(companyId); // Para t."companyId" = ?
  if (!isAdminUser && queueIds.length > 0) {
    replacements.push(...queueIds); // Usa apenas os IDs das filas
  }

  // 6. Para attedants: u1."companyId" = ? ou u1.id = ?, e u."companyId" = ? ou u.id = ?
  if (isAdminUser) {
    replacements.push(companyId); // Para u1."companyId" = ?
    replacements.push(companyId); // Para u."companyId" = ?
  } else if (user) {
    replacements.push(params.currentUser); // Para u1.id = ?
    replacements.push(params.currentUser); // Para u.id = ?
  }

  const finalQuery = query.replace("-- filterPeriod", whereFilter);

  const responseData: DashboardData = await sequelize.query(finalQuery, {
    replacements,
    type: QueryTypes.SELECT,
    plain: true,
  });

  return responseData;
}