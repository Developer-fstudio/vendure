import { Inject, Injectable } from '@nestjs/common';
import {
    CurrencyCode,
    Customer,
    Logger,
    Order,
    RequestContext,
    TransactionalConnection,
} from '@vendure/core';
import Stripe from 'stripe';

import { loggerCtx, STRIPE_PLUGIN_OPTIONS } from './constants';
import { StripePluginOptions } from './types';

@Injectable()
export class StripeService {
    protected stripe: Stripe;

    constructor(
        private connection: TransactionalConnection,
        @Inject(STRIPE_PLUGIN_OPTIONS) private options: StripePluginOptions,
    ) {
        this.stripe = new Stripe(this.options.apiKey, {
            apiVersion: '2020-08-27',
        });
    }

    async createPaymentIntent(ctx: RequestContext, order: Order): Promise<string | undefined> {
        let customerId: string | undefined;

        if (this.options.storeCustomersInStripe && ctx.activeUserId) {
            customerId = await this.getStripeCustomerId(ctx, order);
        }

        // From the [Stripe docs](https://stripe.com/docs/currencies#zero-decimal):
        // > All API requests expect amounts to be provided in a currency’s smallest unit.
        // > For example, to charge 10 USD, provide an amount value of 1000 (that is, 1000 cents).
        // > For zero-decimal currencies, still provide amounts as an integer but without multiplying by 100.
        // > For example, to charge ¥500, provide an amount value of 500.
        //
        // Therefore, for a fractionless currency like JPY, we need to divide the amount by 100 (since Vendure always
        // stores money amounts multiplied by 100). See https://github.com/vendure-ecommerce/vendure/issues/1630
        const amountInMinorUnits = this.currencyHasFractionPart(order.currencyCode)
            ? order.totalWithTax
            : Math.round(order.totalWithTax / 100);

        const { client_secret } = await this.stripe.paymentIntents.create({
            amount: amountInMinorUnits,
            currency: order.currencyCode.toLowerCase(),
            customer: customerId,
            automatic_payment_methods: {
                enabled: true,
            },
            metadata: {
                channelToken: ctx.channel.token,
                orderId: order.id,
                orderCode: order.code,
            },
        });

        if (!client_secret) {
            // This should never happen
            Logger.warn(
                `Payment intent creation for order ${order.code} did not return client secret`,
                loggerCtx,
            );
        }

        return client_secret ?? undefined;
    }

    async createRefund(paymentIntentId: string, amount: number): Promise<Stripe.Refund | Stripe.StripeError> {
        // TODO: Consider passing the "reason" property once this feature request is addressed:
        // https://github.com/vendure-ecommerce/vendure/issues/893
        try {
            const refund = await this.stripe.refunds.create({
                payment_intent: paymentIntentId,
                amount,
            });

            return refund;
        } catch (e: any) {
            return e as Stripe.StripeError;
        }
    }

    constructEventFromPayload(payload: Buffer, signature: string): Stripe.Event {
        return this.stripe.webhooks.constructEvent(payload, signature, this.options.webhookSigningSecret);
    }

    /**
     * Returns the stripeCustomerId if the Customer has one. If that's not the case, queries Stripe to check
     * if the customer is already registered, in which case it saves the id as stripeCustomerId and returns it.
     * Otherwise, creates a new Customer record in Stripe and returns the generated id.
     */
    private async getStripeCustomerId(ctx: RequestContext, activeOrder: Order): Promise<string | undefined> {
        // Load relation with customer not available in the response from activeOrderService.getOrderFromContext()
        const order = await this.connection.getRepository(Order).findOne(activeOrder.id, {
            relations: ['customer'],
        });

        if (!order || !order.customer) {
            // This should never happen
            return undefined;
        }

        const { customer } = order;

        if (customer.customFields.stripeCustomerId) {
            return customer.customFields.stripeCustomerId;
        }

        let stripeCustomerId;

        const stripeCustomers = await this.stripe.customers.list({ email: customer.emailAddress });
        if (stripeCustomers.data.length > 0) {
            stripeCustomerId = stripeCustomers.data[0].id;
        } else {
            const newStripeCustomer = await this.stripe.customers.create({
                email: customer.emailAddress,
                name: `${customer.firstName} ${customer.lastName}`,
            });

            stripeCustomerId = newStripeCustomer.id;

            Logger.info(`Created Stripe Customer record for customerId ${customer.id}`, loggerCtx);
        }

        customer.customFields.stripeCustomerId = stripeCustomerId;
        await this.connection.getRepository(ctx, Customer).save(customer, { reload: false });

        return stripeCustomerId;
    }

    private currencyHasFractionPart(currencyCode: CurrencyCode): boolean {
        const parts = new Intl.NumberFormat(undefined, {
            style: 'currency',
            currency: currencyCode,
            currencyDisplay: 'symbol',
        }).formatToParts(123.45);
        const hasFractionPart = !!parts.find(p => p.type === 'fraction');
        return hasFractionPart;
    }
}
