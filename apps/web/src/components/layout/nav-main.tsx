'use client';

import { Globe, LayoutDashboard, MessageSquare, Newspaper, Tv, Youtube } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
	SidebarGroup,
	SidebarGroupLabel,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
	useSidebar,
} from '@/components/ui/sidebar';

const items = [
	{ title: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
	{ title: 'Browser', href: '/browser', icon: Globe },
];

/**
 * One entry per domain screen. A page nothing links to does not ship, however
 * finished it is, so a domain lands here in the same change that builds it.
 */
const domainItems = [
	{ title: 'Hacker News', href: '/hackernews', icon: Newspaper },
	{ title: 'Reddit', href: '/reddit', icon: MessageSquare },
	{ title: 'Twitch', href: '/twitch', icon: Tv },
	{ title: 'YouTube', href: '/youtube', icon: Youtube },
];

export function NavMain() {
	const pathname = usePathname();
	const { setOpenMobile } = useSidebar();

	const group = (label: string, entries: typeof items) => (
		<SidebarGroup>
			<SidebarGroupLabel>{label}</SidebarGroupLabel>
			<SidebarMenu>
				{entries.map((item) => (
					<SidebarMenuItem key={item.href}>
						<SidebarMenuButton
							asChild
							isActive={pathname === item.href}
							onClick={() => setOpenMobile(false)}
						>
							<Link href={item.href}>
								<item.icon />
								<span>{item.title}</span>
							</Link>
						</SidebarMenuButton>
					</SidebarMenuItem>
				))}
			</SidebarMenu>
		</SidebarGroup>
	);

	return (
		<>
			{group('Navigation', items)}
			{group('Domains', domainItems)}
		</>
	);
}
