/** Adapted from ui-theme AppearanceRow.tsx; MIT copyright retained. */
import { Moon, Sun, Laptop } from 'lucide-react'
import css from './AppearanceRow.module.css'

export function AppearanceRow({ value, onChange, labels }: { value: string; onChange: (value:'light'|'dark'|'system')=>void; labels: { title:string; light:string; dark:string; system:string } }) {
  const options = [
    { id:'light' as const, label:labels.light, icon:<Sun size={18}/> },
    { id:'dark' as const, label:labels.dark, icon:<Moon size={18}/> },
    { id:'system' as const, label:labels.system, icon:<Laptop size={18}/> },
  ]
  return <div className={css.group}><div className={css.title}>{labels.title}</div><div className={css.cubeRow}>{options.map(option=><button key={option.id} className={`${css.themeCube} ${value===option.id?css.selected:''}`} type="button" aria-pressed={value===option.id} onClick={()=>onChange(option.id)}>{option.icon}{option.label}</button>)}</div></div>
}
