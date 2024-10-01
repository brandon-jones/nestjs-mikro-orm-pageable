import { EntityRepository, QueryBuilder } from '@mikro-orm/knex';
import { Dictionary } from '@mikro-orm/core';
import { DriverName, ExtendedPaginateQuery, PaginateConfig, Paginated, Relation } from './types';
import { getAlias } from './helpers';
import { addFilter } from './filter';

export class PageFactory<TEntity extends object, TOutput extends object = TEntity, TPage = Paginated<TOutput>> {
    protected driverName: DriverName | string;
    protected isEntityRepository: boolean;
    protected readonly query: ExtendedPaginateQuery;

    constructor(
        query: ExtendedPaginateQuery,
        protected repo: EntityRepository<TEntity> | QueryBuilder<TEntity>,
        protected _config: PaginateConfig<TEntity> = {},
        protected _map: (entity: TEntity & Dictionary) => TOutput & Dictionary = (entity) => entity as unknown as TOutput & Dictionary
    ) {
        this.query = query;
        if (this.repo.constructor.name === 'QueryBuilder') {
            this.driverName = (this.repo as any).driver.constructor.name;
            this.isEntityRepository = false;
        } else {
            this.driverName = (repo as EntityRepository<TEntity>).getEntityManager().getDriver().constructor.name;
            this.isEntityRepository = true;
        }
    }

    public map<TMappedOutput extends object, TMappedPage = Paginated<TMappedOutput>>(mapper: (entity: TEntity & Dictionary) => TMappedOutput): PageFactory<TEntity, TMappedOutput, TMappedPage> {
        return new PageFactory<TEntity, TMappedOutput, TMappedPage>(this.query, this.repo, this._config, mapper);
    }

    public config(config: PaginateConfig<TEntity>): PageFactory<TEntity, TOutput, TPage> {
        this._config = config;
        return this;
    }

    public async create(): Promise<TPage> {
        const { select, sortable, relations, where, alias } = this._config;
        const queryBuilder: QueryBuilder<TEntity> = this.isEntityRepository ? (this.repo as EntityRepository<TEntity>).createQueryBuilder(alias) : (this.repo as QueryBuilder<TEntity>);

        if (this.query.unpaged) {
            this.query.currentPage = 0;
            this.query.offset = 0;
            this.query.itemsPerPage = 0;
        }

        if (undefined !== select) {
            queryBuilder.select(select);
        }

        const applyRelation = (relation: Relation) => {
            queryBuilder[relation.andSelect ? 'joinAndSelect' : 'join'](relation.property, relation.alias ?? getAlias(relation.property), relation.cond, relation.type, relation.path);
        };

        Array.isArray(relations) ? relations.forEach(applyRelation) : relations && applyRelation(relations);

        if (where) {
            queryBuilder.where(where);
        }

        if (Object.keys(this.query.filter).length) {
            addFilter<TEntity>(queryBuilder, this.query);
        }

        const queryBuilderCount = queryBuilder.clone();
        let totalItems = await queryBuilderCount.getCount();

        if (this.query.limit !== undefined) {
            queryBuilder.limit(this.query.limit);
            totalItems = Math.min(totalItems, this.query.limit);
        }

        this.query.sortBy = this.query.sortBy.filter((s) => sortable?.includes(s.property) ?? true);

        // TODO: This is generating an issue when using query builder, it order not correctly
        // queryBuilder.orderBy(getQBQueryOrderMap(sortBy, this.driverName));

        if (!this.query.unpaged) {
            const difference = this.query.offset + this.query.itemsPerPage - totalItems;
            queryBuilder.offset(this.query.offset).limit(this.query.itemsPerPage - (difference > 0 ? difference : 0));
        }

        const result = await queryBuilder.getResultList();
        const data = result.map(this._map);
        const totalPages = Math.ceil(totalItems / this.query.itemsPerPage);

        const url: URL = this.query.url as URL;
        url.searchParams.set('limit', this.query.itemsPerPage.toString());
        const buildLink = (p: number): string => {
            url.searchParams.set('page', p.toString());
            return url.toString();
        };

        return {
            data,
            meta: {
                currentPage: this.query.currentPage,
                offset: this.query.offset,
                itemsPerPage: this.query.itemsPerPage,
                unpaged: this.query.unpaged,
                totalPages,
                totalItems,
                sortBy: this.query.sortBy,
                filter: this.query.filter
            },
            links: {
                first: this.query.currentPage == 1 ? undefined : buildLink(1),
                previous: this.query.currentPage - 1 < 1 ? undefined : buildLink(this.query.currentPage - 1),
                current: buildLink(this.query.currentPage),
                next: this.query.currentPage + 1 > totalPages ? undefined : buildLink(this.query.currentPage + 1),
                last: this.query.currentPage == totalPages || !totalItems ? undefined : buildLink(totalPages)
            }
        } as TPage;
    }
}
