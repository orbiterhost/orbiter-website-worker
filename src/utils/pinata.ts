import { Context } from 'hono';
import { PinataSDK } from 'pinata-web3';

export const getSiteData = async (c: Context, cid: string) => {
	try {
		const pinata = new PinataSDK({
			pinataJwt: "",
			pinataGateway: c.env.PINATA_GATEWAY,
		});

		const data = await pinata.gateways.get(cid);
		return data;
	} catch (error) {
		console.log(error);
		throw error;
	}
};
